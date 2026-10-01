//! Public local process requests and original-operation recovery reports.
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
    pub completeness: ProcessObservationCompleteness,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReconcileProcessArguments {
    /// Original terminal process.run_local Operation, never a caller-supplied PID.
    pub operation_id: String,
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

/// Completeness of visible native process evidence, distinct from transport status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProcessObservationCompleteness {
    Complete,
    Partial,
    Unknown,
}

impl RunLocalArguments {
    pub fn validate(&self) -> Result<(), String> {
        if self.program.is_empty()
            || self.program.len() > 4096
            || self.program.contains('\0')
            || self.args.len() > 256
            || self.args.iter().any(|arg| arg.contains('\0'))
            || self
                .stdin
                .as_ref()
                .is_some_and(|input| input.len() > 128 * 1024)
            || !(1..=3_600_000).contains(&self.timeout_ms)
            || !(1..=131072).contains(&self.output_limit_bytes)
        {
            return Err("process arguments exceed their declared bounds".into());
        }
        Ok(())
    }
}
