use super::{RunROutput, WorkspaceRunHandler, runtime_error};
use async_trait::async_trait;
use rho_contract::{CapabilityDescriptor, CapabilityRef, Operation, TargetRef};
use rho_operation::{CommitPlan, HandlerError, OperationError, OperationHandler};
use schemars::schema_for;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::Arc;

const MAX_TOOL_CODE_BYTES: usize = 64 * 1024;
pub use rho_r_api::{HelpArguments, LintArguments, FormatArguments, WorkspaceToolRequest};
#[derive(Clone, Copy)]
pub enum WorkspaceToolKind {
    Help,
    Lint,
    Format,
}

pub struct WorkspaceToolHandler {
    owner: Arc<WorkspaceRunHandler>,
    descriptor: CapabilityDescriptor,
    kind: WorkspaceToolKind,
}

impl WorkspaceToolHandler {
    pub fn new(owner: Arc<WorkspaceRunHandler>, kind: WorkspaceToolKind) -> Self {
        let (id, schema) = match kind {
            WorkspaceToolKind::Help => ("workspace.help", schema_for!(HelpArguments).to_value()),
            WorkspaceToolKind::Lint => ("workspace.lint", schema_for!(LintArguments).to_value()),
            WorkspaceToolKind::Format => {
                ("workspace.format", schema_for!(FormatArguments).to_value())
            }
        };
        // Loading native tooling can mutate namespaces/options, and code tools
        // need bounded execution and cancellation. These are explicit Operations,
        // not background Queries or permission-free eval shortcuts.
        let mut descriptor = owner.descriptor.clone();
        descriptor.capability = CapabilityRef::new(id, 1).unwrap();
        descriptor.documentation = rho_contract::builtin_documentation(id);
        descriptor.input_schema = schema;
        descriptor.output_schema = rho_contract::payload_envelope(
            schema_for!(RunROutput).to_value(),
            "value",
            match kind {
                WorkspaceToolKind::Help => schema_for!(rho_contract::HelpResult).to_value(),
                WorkspaceToolKind::Lint => schema_for!(rho_contract::LintResult).to_value(),
                WorkspaceToolKind::Format => schema_for!(rho_contract::FormatResult).to_value(),
            },
        );
        Self {
            owner,
            descriptor,
            kind,
        }
    }

    fn parse(&self, value: &Value) -> Result<WorkspaceToolRequest, OperationError> {
        let invalid = |error: serde_json::Error| OperationError::InvalidInput(error.to_string());
        let request = match self.kind {
            WorkspaceToolKind::Help => {
                let args: HelpArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
                let package_ok = args.package.len() <= 128
                    && args.package.starts_with(|c: char| c.is_ascii_alphabetic())
                    && args
                        .package
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.');
                if args.library_path.is_some() != args.observation_id.is_some()
                    || args
                        .library_path
                        .as_ref()
                        .is_some_and(|p| p.is_empty() || p.len() > 16384 || p.contains('\0'))
                    || args.observation_id.as_ref().is_some_and(|id| {
                        id.is_empty()
                            || id.len() > 64
                            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    })
                    || args.expected_index_files.as_ref().is_some_and(|files| {
                        args.library_path.is_none()
                            || files.len() != 4
                            || files
                                .iter()
                                .any(|f| f.path.len() > 128 || f.digest.len() > 32768)
                    })
                    || !package_ok
                    || args.topic.trim().is_empty()
                    || args.topic.len() > 128
                    || args.topic.chars().any(char::is_control)
                    || args.max_chars == 0
                    || args.max_chars > 32768
                {
                    return Err(OperationError::InvalidInput(
                        "help requires a bounded topic, package name and max_chars in 1..=32768"
                            .into(),
                    ));
                }
                WorkspaceToolRequest::Help(args)
            }
            WorkspaceToolKind::Lint => {
                let args: LintArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
                validate_code(&args.code)?;
                if args.limit == 0 || args.limit > 200 {
                    return Err(OperationError::InvalidInput(
                        "lint limit must be 1..=200".into(),
                    ));
                }
                WorkspaceToolRequest::Lint(args)
            }
            WorkspaceToolKind::Format => {
                let args: FormatArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                validate_code(&args.code)?;
                WorkspaceToolRequest::Format(args)
            }
        };
        Ok(request)
    }
}
fn validate_code(code: &str) -> Result<(), OperationError> {
    if code.len() > MAX_TOOL_CODE_BYTES || code.contains('\0') {
        return Err(OperationError::InvalidInput(
            "code tools accept at most 64 KiB of R text without NUL".into(),
        ));
    }
    Ok(())
}
#[derive(Serialize)]
struct ToolFact<'a> {
    operation_id: &'a rho_contract::OperationId,
    session_id: &'a str,
    action: &'a str,
    input_digest: &'a str,
}

#[async_trait]
impl OperationHandler for WorkspaceToolHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        self.owner.runtime.project_root().map(str::to_owned)
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let value = match self.parse(value)? {
            WorkspaceToolRequest::Help(args) => serde_json::to_value(args),
            WorkspaceToolRequest::Lint(args) => serde_json::to_value(args),
            WorkspaceToolRequest::Format(args) => serde_json::to_value(args),
        };
        value.map_err(|error| OperationError::InvalidInput(error.to_string()))
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(TargetRef {
            kind: "workspace".into(),
            identity: self.owner.runtime.session_id().into(),
        })
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        self.execute_controlled(operation, tokio::sync::watch::channel(false).1)
            .await
    }
    async fn execute_controlled(
        &self,
        operation: &Operation,
        cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        let _lane = self.owner.lane.lock().await;
        if *cancellation.borrow() {
            return Ok(CommitPlan::cancelled_before_start());
        }
        self.owner.check_preconditions(operation)?;
        let request = self
            .parse(&operation.normalized_arguments)
            .map_err(|error| HandlerError::before_effect(error.to_string()))?;
        let report = self
            .owner
            .runtime
            .execute_tool_controlled(operation, &request, cancellation)
            .await
            .map_err(runtime_error)?;
        let fact = serde_json::to_value(ToolFact {
            operation_id: &operation.operation_id,
            session_id: &operation.target.identity,
            action: request.action(),
            input_digest: &operation.invocation_digest,
        })
        .map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?;
        let event = json!({"session_id":operation.target.identity, "action":request.action(), "outcome":report.outcome});
        self.owner.finish_report(
            operation,
            report,
            "rho.workspace.tool.v1",
            fact,
            "workspace.tool_observed",
            event,
        )
    }
}
