//! Public process-plugin observations and resource-backed execution results.
use crate::{OutputCapture, ProcessTermination};
use rho_plugin_protocol::{ContentDigest, OperationId, ResourceReference};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProcessRunResult {
    pub operation: OperationId,
    /// Exact JSON-encoded ProcessReport, including bounded original byte streams.
    pub report: ResourceReference,
    pub pid: Option<u32>,
    pub termination: ProcessTermination,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProcessRunRecovery {
    pub operation: OperationId,
    pub project_root: String,
    pub pid: Option<u32>,
    /// Native report transfer may fail after execution. An empty reference never
    /// establishes absence of effects or authorizes another execution.
    pub report: Option<ResourceReference>,
    pub native_termination: Option<ProcessTermination>,
    pub report_digest: Option<ContentDigest>,
    pub stdout: Option<OutputCapture>,
    pub stderr: Option<OutputCapture>,
    pub report_transfer_confirmed: bool,
    pub automatic_reexecution: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProcessPhase {
    Waiting,
    Running,
    AwaitingSettlement,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProcessActivity {
    pub operation: OperationId,
    pub phase: ProcessPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProcessStatus {
    /// Native scheduling only. Committed outcomes belong to operation.get.
    pub activities: Vec<ProcessActivity>,
    pub capacity: u16,
}
