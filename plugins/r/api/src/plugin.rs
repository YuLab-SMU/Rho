//! Public R plugin messages. Source labels describe a caller's input; they do
//! not attest to a Host document capture or expand its authorized scope.
use crate::{MediaReference, OperationId, OutputEvents, RunRArguments, RunROutputMode, RunSource};
use rho_plugin_protocol::ResourceReference;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ExecuteR {
    #[schemars(length(min = 1, max = 160))]
    pub expected_session: String,
    pub run: RunRArguments,
}
/// An explicit code-tool Operation in an already selected native session.
/// Formatting parses text; it does not evaluate it or write a project file.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct FormatRCode {
    #[schemars(length(min = 1, max = 160))]
    pub expected_session: String,
    #[schemars(length(max = 65536))]
    pub code: String,
    #[serde(default)]
    pub source: Option<RunSource>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CheckRCode {
    #[schemars(length(min = 1, max = 160))]
    pub expected_session: String,
    #[schemars(length(min = 1, max = 262144))]
    pub code: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadREvents {
    #[schemars(length(min = 1, max = 160))]
    pub expected_session: String,
    pub operation_id: OperationId,
    #[serde(default)]
    pub after_sequence: u64,
    #[serde(default = "event_limit")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}
fn event_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct REventsObservation {
    pub session_id: String,
    pub output: OutputEvents,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RetainedROutput {
    pub native: MediaReference,
    pub reference: ResourceReference,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RExecutionResult {
    pub operation_id: OperationId,
    pub session_id: String,
    /// R's dynamic value; larger values remain in the full retained report.
    pub value: Value,
    pub value_in_report: bool,
    pub stdout: String,
    pub stderr: String,
    pub report: ResourceReference,
    pub events: ResourceReference,
    pub outputs: Vec<RetainedROutput>,
    pub source: Option<RunSource>,
    pub output_mode: Option<RunROutputMode>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RExecutionNotStarted {
    pub operation_id: OperationId,
    /// Always false when the owner confirms cancellation before native execution.
    #[schemars(extend("const" = false))]
    #[ts(type = "false")]
    pub started: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum RExecutionOutput {
    Native(RExecutionResult),
    NotStarted(RExecutionNotStarted),
}

/// One validation rule is shared by preflight, native admission and execution.
pub fn validate_r_input(code: &str, source: Option<&RunSource>) -> Result<(), String> {
    if code.is_empty() || code.len() > 256 * 1024 || code.contains('\0') {
        return Err("R code must contain 1–262144 UTF-8 bytes without NUL".into());
    }
    validate_r_source(source)
}
pub fn validate_r_format(code: &str, source: Option<&RunSource>) -> Result<(), String> {
    if code.len() > 64 * 1024 || code.contains('\0') {
        return Err("R formatting accepts at most 65536 UTF-8 bytes without NUL".into());
    }
    validate_r_source(source)
}
fn validate_r_source(source: Option<&RunSource>) -> Result<(), String> {
    if let Some(source) = source {
        for (value, max) in [
            (&source.view_id, 160),
            (&source.label, 512),
            (&source.kind, 64),
        ] {
            if value.is_empty() || value.len() > max || value.contains('\0') {
                return Err("R source labels exceed their UTF-8 bounds or contain NUL".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn formatting_has_independent_byte_bounds_and_retains_source() {
        let value = json!({"expected_session":"native","code":"中文=1","source":{"view_id":"document:one","label":"分析.R","kind":"format"}});
        let args: FormatRCode = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&args).unwrap(), value);
        validate_r_format(&args.code, args.source.as_ref()).unwrap();
        assert!(validate_r_format("", None).is_ok());
        assert!(validate_r_format(&"x".repeat(65536), None).is_ok());
        assert!(validate_r_format(&"中".repeat(21846), None).is_err());
        assert!(validate_r_format("x\0", None).is_err());
        let mut source = args.source.unwrap();
        source.label = "中".repeat(200);
        assert!(validate_r_format("x=1", Some(&source)).is_err());
        let mut invalid = value;
        invalid["install_missing"] = json!(true);
        assert!(serde_json::from_value::<FormatRCode>(invalid).is_err());
    }
    #[test]
    fn original_run_options_are_retained_and_byte_bounds_apply_before_admission() {
        let value = json!({"expected_session":"native","run":{"code":"中文 <- 1","output_mode":"console","source":{"view_id":"draft:1","label":"分析.R","kind":"selection"}}});
        let args: ExecuteR = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&args).unwrap(), value);
        validate_r_input(&args.run.code, args.run.source.as_ref()).unwrap();
        assert!(validate_r_input(&"中".repeat(100000), None).is_err());
        assert!(validate_r_input("1\0", None).is_err());
        let mut source = args.run.source.unwrap();
        source.label = "中".repeat(200);
        assert!(validate_r_input("1", Some(&source)).is_err());
        let mut invalid = value.clone();
        invalid["run"]["permission"] = json!("extra");
        assert!(serde_json::from_value::<ExecuteR>(invalid).is_err());
        let mut invalid = value;
        invalid["run"]["output_mode"] = json!("silent");
        assert!(serde_json::from_value::<ExecuteR>(invalid).is_err());
    }
}
