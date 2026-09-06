#![forbid(unsafe_code)]

mod query;
pub use query::*;
mod tools;
pub use tools::*;

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use rho_contract::{
    CancellationClass, CapabilityDescriptor, CapabilityRef, EffectHint, EffectObservation,
    IdempotencyClass, Operation, OperationOutcome, RetryClass, TargetRef,
};
use rho_operation::{
    CommitPlan, DomainFactMutation, EffectBoundary, HandlerError, OperationError, OperationHandler,
    PlannedEvent,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const RUN_R_CAPABILITY_ID: &str = "workspace.run_r";
pub const RUN_R_CAPABILITY_VERSION: u16 = 1;
pub const RUN_R_SCOPE: &str = "workspace.run_r";
const MAX_CODE_BYTES: usize = rho_contract::MAX_ARGUMENT_BYTES;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunRArguments {
    #[schemars(length(min = 1))]
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunROutput {
    pub session_id: String,
    pub value: Value,
    pub stdout: String,
    pub stderr: String,
    pub conditions: Vec<Value>,
    pub output_references: Vec<Value>,
}

#[derive(Serialize)]
struct WorkspaceExecutionFact<'a> {
    session_id: &'a str,
    code_digest: &'a str,
    // Full output lives in the operation record; no duplicate result store.
    operation_id: &'a rho_contract::OperationId,
}

impl RunRArguments {
    fn validate(&self) -> Result<(), OperationError> {
        if self.code.trim().is_empty() {
            return Err(OperationError::InvalidInput(
                "workspace.run_r code must not be empty".to_string(),
            ));
        }
        if self.code.len() > MAX_CODE_BYTES {
            return Err(OperationError::InvalidInput(format!(
                "workspace.run_r code exceeds {MAX_CODE_BYTES} bytes"
            )));
        }
        if self.code.contains('\0') {
            return Err(OperationError::InvalidInput(
                "workspace.run_r code contains NUL".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceRuntimeReport {
    pub session_id: String,
    pub value: Value,
    pub stdout: String,
    pub stderr: String,
    pub conditions: Vec<Value>,
    pub output_references: Vec<Value>,
    pub effect_observations: Vec<EffectObservation>,
    pub outcome: OperationOutcome,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRuntimeError {
    pub message: String,
    pub effect_may_have_occurred: bool,
    pub recovery: Option<Value>,
}

impl WorkspaceRuntimeError {
    pub fn before_effect(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            effect_may_have_occurred: false,
            recovery: None,
        }
    }

    pub fn after_possible_effect(message: impl Into<String>, recovery: Option<Value>) -> Self {
        Self {
            message: message.into(),
            effect_may_have_occurred: true,
            recovery,
        }
    }
}

#[async_trait]
pub trait WorkspaceRuntime: Send + Sync {
    fn session_id(&self) -> &str;
    fn project_root(&self) -> Option<&str> {
        None
    }

    async fn query(
        &self,
        _query: &WorkspaceQuery,
    ) -> Result<WorkspaceObservation, WorkspaceRuntimeError> {
        Err(WorkspaceRuntimeError::before_effect(
            "this runtime does not support Workspace inspection",
        ))
    }

    async fn execute(
        &self,
        operation: &Operation,
        request: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError>;

    async fn execute_controlled(
        &self,
        operation: &Operation,
        request: &RunRArguments,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        self.execute(operation, request).await
    }

    async fn execute_tool_controlled(
        &self,
        _operation: &Operation,
        _request: &WorkspaceToolRequest,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        Err(WorkspaceRuntimeError::before_effect(
            "this runtime does not support R code tools",
        ))
    }
}

pub struct WorkspaceRunHandler {
    descriptor: CapabilityDescriptor,
    runtime: Arc<dyn WorkspaceRuntime>,
    lane: Arc<tokio::sync::Mutex<()>>,
}

impl WorkspaceRunHandler {
    pub fn new(runtime: Arc<dyn WorkspaceRuntime>) -> Self {
        Self::with_lane(runtime, Arc::new(tokio::sync::Mutex::new(())))
    }

    pub fn with_lane(
        runtime: Arc<dyn WorkspaceRuntime>,
        lane: Arc<tokio::sync::Mutex<()>>,
    ) -> Self {
        let required_scopes = BTreeSet::from([RUN_R_SCOPE.to_string()]);
        let potential_effects = BTreeSet::from([
            EffectHint::NeedsNetwork,
            EffectHint::MayWriteProject,
            EffectHint::MayMutateRuntime,
            EffectHint::MaySpawnProcess,
            EffectHint::UsesSecret,
            EffectHint::ProducesArtifact,
        ]);
        Self {
            descriptor: CapabilityDescriptor {
                kind: rho_contract::CapabilityKind::Operation,
                capability: CapabilityRef::new(RUN_R_CAPABILITY_ID, RUN_R_CAPABILITY_VERSION)
                    .expect("static capability identity is valid"),
                domain: "workspace".to_string(),
                input_schema: schema_for!(RunRArguments).to_value(),
                output_schema: schema_for!(RunROutput).to_value(),
                required_scopes,
                potential_effects,
                idempotency: IdempotencyClass::CallerScoped,
                retry: RetryClass::ReconcileFirst,
                cancellation: CancellationClass::Cooperative,
            },
            runtime,
            lane,
        }
    }

    fn request(&self, operation: &Operation) -> Result<RunRArguments, HandlerError> {
        let request: RunRArguments = serde_json::from_value(operation.normalized_arguments.clone())
            .map_err(|error| HandlerError::before_effect(error.to_string()))?;
        request
            .validate()
            .map_err(|error| HandlerError::before_effect(error.to_string()))?;
        Ok(request)
    }

    fn check_preconditions(&self, operation: &Operation) -> Result<(), HandlerError> {
        for precondition in &operation.preconditions {
            match precondition.kind.as_str() {
                "workspace.session" if precondition.subject == "active" => {
                    let expected = precondition.expected.as_str().ok_or_else(|| {
                        HandlerError::before_effect(
                            "workspace.session precondition requires a string value",
                        )
                    })?;
                    if expected != self.runtime.session_id() {
                        return Err(HandlerError::before_effect(format!(
                            "workspace session precondition failed: expected {expected}, actual {}",
                            self.runtime.session_id()
                        )));
                    }
                }
                _ => {
                    return Err(HandlerError::before_effect(format!(
                        "unsupported workspace precondition {} for {}",
                        precondition.kind, precondition.subject
                    )));
                }
            }
        }
        Ok(())
    }

    fn finish_report(
        &self,
        operation: &Operation,
        report: WorkspaceRuntimeReport,
        fact_schema: &str,
        fact: Value,
        event_kind: &str,
        event_payload: Value,
    ) -> Result<CommitPlan, HandlerError> {
        if report.session_id != operation.target.identity {
            return Err(HandlerError::after_possible_effect(
                "Workspace runtime session changed while executing",
                Some(json!({"expected_session_id": operation.target.identity,
                    "observed_session_id": report.session_id})),
            ));
        }
        let output = serde_json::to_value(RunROutput {
            session_id: report.session_id,
            value: report.value,
            stdout: report.stdout,
            stderr: report.stderr,
            conditions: report.conditions,
            output_references: report.output_references,
        })
        .map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?;
        let mut plan = CommitPlan::succeeded(output);
        plan.outcome = report.outcome;
        plan.error = report.error;
        if plan.outcome == OperationOutcome::Uncertain {
            plan.recovery = Some(
                json!({"action":"observe_workspace_before_retry", "session_id":operation.target.identity}),
            );
        }
        plan.facts.push(DomainFactMutation {
            domain: "workspace".into(),
            schema: fact_schema.into(),
            key: operation.operation_id.as_str().into(),
            value: fact,
        });
        plan.effect_observations = report.effect_observations;
        plan.events.push(PlannedEvent {
            kind: event_kind.into(),
            payload: event_payload,
        });
        Ok(plan)
    }
}

fn runtime_error(error: WorkspaceRuntimeError) -> HandlerError {
    HandlerError {
        message: error.message,
        effect_boundary: if error.effect_may_have_occurred {
            EffectBoundary::MayHaveOccurred
        } else {
            EffectBoundary::NotStarted
        },
        recovery: error.recovery,
        cancellation_confirmed: false,
    }
}

#[async_trait]
impl OperationHandler for WorkspaceRunHandler {
    fn idempotency_scope(&self) -> Option<String> {
        self.runtime.project_root().map(str::to_string)
    }
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        let request: RunRArguments = serde_json::from_value(arguments.clone())
            .map_err(|error| OperationError::InvalidInput(error.to_string()))?;
        request.validate()?;
        serde_json::to_value(request)
            .map_err(|error| OperationError::InvalidInput(error.to_string()))
    }

    fn resolve_target(&self, _arguments: &Value) -> Result<TargetRef, OperationError> {
        Ok(TargetRef {
            kind: "workspace".to_string(),
            identity: self.runtime.session_id().to_string(),
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
        let _lane = self.lane.lock().await;
        if *cancellation.borrow() {
            let mut plan = CommitPlan::succeeded(json!({"execution_started": false}));
            plan.outcome = OperationOutcome::Cancelled;
            return Ok(plan);
        }
        self.check_preconditions(operation)?;
        let request = self.request(operation)?;
        let report = self
            .runtime
            .execute_controlled(operation, &request, cancellation)
            .await
            .map_err(runtime_error)?;

        let code_digest = format!("sha256:{:x}", Sha256::digest(request.code.as_bytes()));
        let encode_error =
            |error: serde_json::Error| HandlerError::after_possible_effect(error.to_string(), None);
        let fact = serde_json::to_value(WorkspaceExecutionFact {
            operation_id: &operation.operation_id,
            session_id: &operation.target.identity,
            code_digest: &code_digest,
        })
        .map_err(encode_error)?;
        let event = json!({
            "session_id": operation.target.identity,
            "code_digest": code_digest,
            "effect_observation_count": report.effect_observations.len(),
        });
        self.finish_report(
            operation,
            report,
            "rho.workspace.execution.v1",
            fact,
            "workspace.execution_observed",
            event,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use rho_contract::{CallerIdentity, CallerKind, OperationId, Precondition};

    use super::*;

    struct CountingRuntime {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl WorkspaceRuntime for CountingRuntime {
        fn session_id(&self) -> &str {
            "session-test"
        }

        async fn execute(
            &self,
            _operation: &Operation,
            request: &RunRArguments,
        ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(WorkspaceRuntimeReport {
                session_id: self.session_id().to_string(),
                value: json!({"echo": request.code}),
                stdout: String::new(),
                stderr: String::new(),
                conditions: Vec::new(),
                output_references: Vec::new(),
                effect_observations: Vec::new(),
                outcome: OperationOutcome::Succeeded,
                error: None,
            })
        }

        async fn execute_tool_controlled(
            &self,
            operation: &Operation,
            request: &WorkspaceToolRequest,
            _cancellation: tokio::sync::watch::Receiver<bool>,
        ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
            self.execute(
                operation,
                &RunRArguments {
                    code: request.action().into(),
                },
            )
            .await
        }
    }

    fn operation(preconditions: Vec<Precondition>) -> Operation {
        Operation {
            principal: None,
            operation_id: OperationId::new("op_test").unwrap(),
            client_request_id: "request_test".to_string(),
            caller: CallerIdentity {
                kind: CallerKind::Human,
                id: "test".to_string(),
            },
            capability: CapabilityRef::new(RUN_R_CAPABILITY_ID, 1).unwrap(),
            domain: "workspace".to_string(),
            target: TargetRef {
                kind: "workspace".to_string(),
                identity: "session-test".to_string(),
            },
            normalized_arguments: json!({"code": "1 + 1"}),
            invocation_digest: "sha256:test".to_string(),
            idempotency_scope: None,
            preconditions,
            potential_effects: BTreeSet::new(),
            correlation_id: "op_test".to_string(),
            causation_id: None,
            trace_parent: None,
            accepted_at_ms: 1,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_session_precondition_does_not_touch_runtime() {
        let runtime = Arc::new(CountingRuntime {
            calls: AtomicUsize::new(0),
        });
        let handler = WorkspaceRunHandler::new(runtime.clone());
        let error = handler
            .execute(&operation(vec![Precondition {
                kind: "workspace.session".to_string(),
                subject: "active".to_string(),
                expected: json!("another-session"),
            }]))
            .await
            .unwrap_err();
        assert_eq!(error.effect_boundary, EffectBoundary::NotStarted);
        assert_eq!(runtime.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn tools_share_scope_preconditions_cancellation_and_commit_discipline() {
        let runtime = Arc::new(CountingRuntime {
            calls: AtomicUsize::new(0),
        });
        let owner = Arc::new(WorkspaceRunHandler::new(runtime.clone()));
        for kind in [
            WorkspaceToolKind::Help,
            WorkspaceToolKind::Lint,
            WorkspaceToolKind::Format,
        ] {
            let handler = WorkspaceToolHandler::new(owner.clone(), kind);
            assert_eq!(
                handler.descriptor().required_scopes,
                owner.descriptor().required_scopes
            );
            let mut op = operation(Vec::new());
            op.capability = handler.descriptor().capability.clone();
            op.normalized_arguments = handler
                .normalize_arguments(&match kind {
                    WorkspaceToolKind::Help => json!({"topic":"mean"}),
                    _ => json!({"code":"x=1"}),
                })
                .unwrap();
            let plan = handler.execute(&op).await.unwrap();
            assert_eq!(plan.outcome, OperationOutcome::Succeeded);
            assert_eq!(plan.facts[0].value["operation_id"], json!(op.operation_id));
            assert_eq!(plan.facts[0].schema, "rho.workspace.tool.v1");
            assert_eq!(plan.events[0].kind, "workspace.tool_observed");
            let before = runtime.calls.load(Ordering::SeqCst);
            let cancelled = handler
                .execute_controlled(&op, tokio::sync::watch::channel(true).1)
                .await
                .unwrap();
            assert_eq!(cancelled.outcome, OperationOutcome::Cancelled);
            op.preconditions.push(Precondition {
                kind: "workspace.session".into(),
                subject: "active".into(),
                expected: json!("stale"),
            });
            assert_eq!(
                handler.execute(&op).await.unwrap_err().effect_boundary,
                EffectBoundary::NotStarted
            );
            assert_eq!(runtime.calls.load(Ordering::SeqCst), before);
        }
    }

    #[test]
    fn tools_normalize_defaults_and_reject_unbounded_or_executable_configuration() {
        let owner = Arc::new(WorkspaceRunHandler::new(Arc::new(CountingRuntime {
            calls: AtomicUsize::new(0),
        })));
        let help = WorkspaceToolHandler::new(owner.clone(), WorkspaceToolKind::Help);
        assert_eq!(
            help.normalize_arguments(&json!({"topic":"mean"})).unwrap(),
            json!({"topic":"mean","package":"base","max_chars":16384})
        );
        for args in [
            json!({"topic":""}),
            json!({"topic":"mean","package":"../base"}),
            json!({"topic":"mean","max_chars":32769}),
        ] {
            assert!(help.normalize_arguments(&args).is_err());
        }
        for kind in [WorkspaceToolKind::Lint, WorkspaceToolKind::Format] {
            let handler = WorkspaceToolHandler::new(owner.clone(), kind);
            for args in [
                json!({"code":"x=1","config":"source('evil.R')"}),
                json!({"code":"a".repeat(65537)}),
                json!({"code":"\u{0}"}),
            ] {
                assert!(handler.normalize_arguments(&args).is_err());
            }
            assert!(handler.normalize_arguments(&json!({"code":""})).is_ok());
        }
        let lint = WorkspaceToolHandler::new(owner, WorkspaceToolKind::Lint);
        assert!(
            lint.normalize_arguments(&json!({"code":"x=1","limit":201}))
                .is_err()
        );
    }
}
