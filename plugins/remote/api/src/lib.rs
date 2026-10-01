//! Public SSH execution and Slurm identities, reports and original-operation recovery.
#![forbid(unsafe_code)]
mod plugin;
pub use plugin::*;
mod validation;
use rho_process_api::ProcessReport;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub use validation::*;

/// Remote evidence classification; journal outcomes are committed by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RemoteExecutionOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
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
    pub outcome: RemoteExecutionOutcome,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_requires_original_and_native_identities() {
        let source_only = json!({"source_operation_id":"op_original"});
        assert!(serde_json::from_value::<RemoteProcessRecovery>(source_only.clone()).is_err());
        assert!(serde_json::from_value::<SlurmSubmissionRecovery>(source_only.clone()).is_err());
        assert!(serde_json::from_value::<SlurmCancelRecovery>(source_only).is_err());
        let cancelled = json!({"source_operation_id":"op_original","job":{"host_alias":"configured","cluster":"cluster_a","job_id":"42","operation_marker":"rho-original","project_root":"/scratch/project","stdout_path":"/scratch/project/rho-original-42.out","stderr_path":"/scratch/project/rho-original-42.err"}});
        let recovery: SlurmCancelRecovery = serde_json::from_value(cancelled.clone()).unwrap();
        assert_eq!(serde_json::to_value(recovery).unwrap(), cancelled);
        let mut malformed = cancelled;
        malformed["job"]
            .as_object_mut()
            .unwrap()
            .remove("operation_marker");
        assert!(serde_json::from_value::<SlurmCancelRecovery>(malformed).is_err());
    }
}
