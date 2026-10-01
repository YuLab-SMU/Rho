//! Public remote-plugin results. Native bytes remain in their original resource.
use crate::{RemoteExecutionOutcome, RemoteTarget, SlurmLookup};
use rho_plugin_protocol::{ContentDigest, OperationId, ResourceReference};
use rho_process_api::{OutputCapture, ProcessActivity};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemoteRunResult {
    pub operation: OperationId,
    pub target: RemoteTarget,
    /// Original JSON RemoteExecutionReport, including bounded transport streams.
    pub report: ResourceReference,
    pub remote_exit_code: Option<i32>,
    pub native_outcome: RemoteExecutionOutcome,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemoteRunRecovery {
    pub operation: OperationId,
    pub project_root: String,
    pub target: RemoteTarget,
    pub report: Option<ResourceReference>,
    pub report_digest: Option<ContentDigest>,
    pub native_outcome: RemoteExecutionOutcome,
    pub stdout: OutputCapture,
    pub stderr: OutputCapture,
    pub report_transfer_confirmed: bool,
    pub automatic_reexecution: bool,
    pub action: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemoteStatus {
    pub target: Option<RemoteTarget>,
    pub target_key: Option<String>,
    pub activities: Vec<ProcessActivity>,
    pub capacity: u16,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemoteConfiguration {
    /// No connection or operation is possible until an explicit target is set.
    #[serde(default)]
    pub target: Option<RemoteTarget>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SlurmSnapshotStatus {
    Ready,
    Busy,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SlurmSnapshot {
    pub source_operation: OperationId,
    pub status: SlurmSnapshotStatus,
    pub lookup: Option<SlurmLookup>,
    pub notice: String,
}
