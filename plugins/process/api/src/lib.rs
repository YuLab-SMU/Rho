//! Public bounded process reports.
#![forbid(unsafe_code)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
