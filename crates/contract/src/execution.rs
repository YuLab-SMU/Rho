use crate::{ObservationCompleteness, OperationOutcome};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

fn default_timeout() -> u64 {
    60_000
}
fn default_output() -> usize {
    64 * 1024
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RunLocalArguments {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default = "default_timeout")]
    #[schemars(range(min = 1, max = 3600000))]
    pub timeout_ms: u64,
    #[serde(default = "default_output")]
    #[schemars(range(min = 1, max = 131072))]
    pub output_limit_bytes: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputCapture {
    pub bytes: Vec<u8>,
    pub total_bytes: u64,
    pub truncated: bool,
    pub eof: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProcessTermination {
    Exited,
    Cancelled,
    TimedOut,
    Uncertain,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ProcessReport {
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub termination: ProcessTermination,
    pub stdout: OutputCapture,
    pub stderr: OutputCapture,
    pub elapsed_ms: u64,
    pub supervision: String,
    pub stdin_error: Option<String>,
    pub cleanup_requested: bool,
    pub cleanup_error: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct NativeProcessIdentity {
    pub pid: u32,
    pub started_at_seconds: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ProcessReconciliation {
    pub source_operation_id: String,
    pub observed: Vec<NativeProcessIdentity>,
    pub signalled: Vec<NativeProcessIdentity>,
    pub remaining: Vec<NativeProcessIdentity>,
    pub no_matching_processes_observed: bool,
    pub completeness: ObservationCompleteness,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReconcileProcessArguments {
    /// Original terminal process.run_local Operation, never a caller-supplied PID.
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct RemoteTarget {
    pub host_alias: String,
    pub project_root: String,
    pub slurm_cluster: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct RemoteExecutionReport {
    pub target: RemoteTarget,
    pub transport: ProcessReport,
    pub remote_exit_code: Option<i32>,
    pub outcome: OperationOutcome,
    pub notice: String,
}

fn one() -> u16 {
    1
}
fn memory_default() -> u32 {
    1024
}
fn time_default() -> u32 {
    10
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SlurmSubmitArguments {
    /// Bash body, not an sbatch option file. Resource options are typed fields.
    pub body: String,
    #[serde(default = "one")]
    #[schemars(range(min = 1, max = 512))]
    pub cpus: u16,
    #[serde(default = "memory_default")]
    #[schemars(range(min = 1, max = 1048576))]
    pub memory_mb: u32,
    #[serde(default = "time_default")]
    #[schemars(range(min = 1, max = 10080))]
    pub time_minutes: u32,
    #[serde(default)]
    #[schemars(range(max = 64))]
    pub gpus: u16,
    #[serde(default)]
    pub partition: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SlurmSourceArguments {
    pub submission_operation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct SlurmJobRef {
    pub host_alias: String,
    pub cluster: String,
    pub job_id: String,
    pub operation_marker: String,
    pub project_root: String,
    pub stdout_path: String,
    pub stderr_path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SlurmObservation {
    pub job: SlurmJobRef,
    pub state: String,
    pub exit_code: Option<String>,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SlurmLookup {
    pub source_operation_id: String,
    pub jobs: Vec<SlurmObservation>,
    pub accounting_lookback_days: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SlurmCancellation {
    pub request_sent: bool,
    pub before: SlurmObservation,
    pub after: Option<SlurmObservation>,
    pub notice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalProcessRecovery {
    pub source_operation_id: String,
    pub pid: Option<u32>,
    pub root: String,
    pub action: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProcessReconcileRecovery {
    pub source_operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemoteProcessRecovery {
    pub source_operation_id: String,
    pub target: RemoteTarget,
    pub action: String,
    pub automatic_reexecution: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SlurmSubmissionRecovery {
    pub source_operation_id: String,
    pub operation_marker: String,
    pub target: RemoteTarget,
    pub action: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum SlurmReconcileRecovery {
    LookupUnavailable {
        source_operation_id: String,
        automatic_reexecution: bool,
    },
    Unresolved {
        source_operation_id: String,
        action: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum SlurmCancelRecovery {
    LookupUnavailable {
        source_operation_id: String,
        automatic_reexecution: bool,
    },
    Ambiguous {
        source_operation_id: String,
        lookup: SlurmLookup,
    },
    RequestUncertain {
        source_operation_id: String,
        job: SlurmJobRef,
    },
}
