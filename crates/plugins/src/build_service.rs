use crate::{build::*, service::*, *};
use async_trait::async_trait;
use rho_contract as host;
use rho_operation::*;
use rho_plugin_protocol::*;
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::{OwnedSemaphorePermit, watch};

pub(crate) fn register(
    service: &Arc<PluginService>,
    registry: &mut CapabilityRegistry,
) -> Result<(), OperationError> {
    registry.register(Arc::new(Build {
        service: service.clone(),
        descriptor: descriptor(),
        revision: None,
    }))
}
fn descriptor() -> host::CapabilityDescriptor {
    host::CapabilityDescriptor {
        kind: host::CapabilityKind::Operation,
        capability: host::CapabilityRef::new("plugins.build", 1).unwrap(), domain: "plugins".into(),
        input_schema: schema_for!(BuildPlugin).to_value(), output_schema: schema_for!(PluginBuildResult).to_value(),
        recovery_schema: json!({"type":["object","null"]}),
        required_scopes: BTreeSet::from([PLUGINS_WRITE_SCOPE.into(), PLUGINS_RUN_SCOPE.into()]),
        potential_effects: BTreeSet::from([host::EffectHint::MaySpawnProcess, host::EffectHint::ProducesArtifact]),
        idempotency: host::IdempotencyClass::CallerScoped, retry: host::RetryClass::ReconcileFirst,
        cancellation: host::CancellationClass::Cooperative,
        documentation: host::CapabilityDocumentation {
            summary: "Build an exact installed source revision".into(),
            purpose: "Run the declared recipe in a fresh native source directory and retain a validated artifact for that same revision.".into(),
            when_to_use: vec!["Build a saved source checkpoint before an explicit isolated preview or application.".into()],
            limitations: vec!["Uses existing local tools and caches. No dependency installer is supplied. Trusted build commands are not an OS filesystem or network sandbox.".into(), "Only one build runs per Host; each output stream retains at most 16 KiB, with total length and truncation. Build directories remain as recovery evidence.".into()],
            owner: "plugins".into(), effects: "Starts only the declared native build. Does not advance a branch, activate an instance, change a scenario or start a scientific runtime.".into(),
            retry_rule: "Retain client_request_id and inspect the original Operation after lost acknowledgement. Never rerun an uncertain build to discover its outcome.".into(),
            cancellation_rule: "Cancellation is confirmed only before execution or after native process supervision confirms cleanup. A cancellation request cannot undo an already committed artifact.".into(),
            preconditions: vec![host::CapabilityPrecondition { parameter: "revision".into(), requirement: "The exact revision must be installed with a build recipe; unrelated native preconditions are rejected.".into(), read_from: Some(host::CapabilityRef::new("plugins.inspect",1).unwrap()) }],
            examples: vec![host::CapabilityExample { arguments: json!({"revision":format!("sha256:{}","0".repeat(64)),"timeout_ms":120000}), result_explanation: "The original Operation holds the exact source, bounded process report and any committed artifact identity.".into() }],
            related_capabilities: vec![host::CapabilityRef::new("plugins.inspect",1).unwrap(),host::CapabilityRef::new("plugins.checkpoint",1).unwrap()],
            related_skills: vec![], position_units: vec!["Timeout is milliseconds, from 1 to 3600000.".into()],
        },
    }
}
fn args(value: &Value) -> Result<BuildPlugin, OperationError> {
    let args: BuildPlugin = serde_json::from_value(value.clone()).map_err(invalid)?;
    if !(1..=3_600_000).contains(&args.timeout_ms) {
        return Err(invalid("invalid build timeout"));
    }
    Ok(args)
}
struct Build {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
    revision: Option<RevisionId>,
}
#[async_trait]
impl OperationHandler for Build {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.service.scope.clone())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        serde_json::to_value(args(value)?).map_err(invalid)
    }
    fn resolve_target(&self, value: &Value) -> Result<host::TargetRef, OperationError> {
        Ok(host::TargetRef {
            kind: "plugin_source".into(),
            identity: args(value)?.revision.to_string(),
        })
    }
    fn execution_context(&self) -> Value {
        json!({"build_revision": self.revision})
    }
    async fn bind(
        &self,
        _: &host::CallContext,
        value: &Value,
        preconditions: &[host::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if !preconditions.is_empty() {
            return Err(invalid(
                "build uses an exact source revision, not unrelated native preconditions",
            ));
        }
        let args = args(value)?;
        let revision = self
            .service
            .repository
            .lock()
            .unwrap()
            .revision(&args.revision)
            .map_err(error)?;
        if revision.manifest.source.build.is_none() {
            return Err(invalid("source has no build recipe"));
        }
        Ok(Some(Arc::new(Self {
            service: self.service.clone(),
            descriptor: self.descriptor.clone(),
            revision: Some(args.revision),
        })))
    }
    fn admitted(&self, operation: &host::Operation) -> Result<(), HandlerError> {
        let revision = self
            .revision
            .as_ref()
            .ok_or_else(|| HandlerError::before_effect("build was not bound"))?;
        self.service
            .repository
            .lock()
            .unwrap()
            .retain("build", operation.operation_id.as_str(), revision)
            .map_err(|e| HandlerError::before_effect(e.to_string()))
    }
    async fn acquire_execution(
        &self,
        operation: &host::Operation,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        let permit = tokio::select! {
            biased;
            _ = wait_cancellation(&mut cancellation) => None,
            permit = self.service.build_capacity.clone().acquire_owned() => Some(permit.map_err(|_|HandlerError::before_effect("build capacity closed"))?),
        };
        Ok(Box::new(BuildLease {
            service: self.service.clone(),
            operation: operation.operation_id.clone(),
            revision: self.revision.clone().unwrap(),
            _permit: permit,
        }))
    }
    async fn execute(&self, operation: &host::Operation) -> Result<CommitPlan, HandlerError> {
        self.execute_controlled(operation, watch::channel(false).1)
            .await
    }
    async fn execute_controlled(
        &self,
        operation: &host::Operation,
        cancellation: watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        if *cancellation.borrow() {
            return Ok(CommitPlan::cancelled_before_start());
        }
        let args = args(&operation.normalized_arguments)
            .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        let repository = self.service.repository.clone();
        let operation_id = operation.operation_id.to_string();
        let revision = args.revision.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            PreparedBuild::prepare(&repository.lock().unwrap(), &revision, &operation_id)
        })
        .await
        .map_err(|e| HandlerError::before_effect(e.to_string()))?
        .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        let recovery = json!({"kind":"plugin_build","source_operation_id":operation.operation_id,"revision":args.revision,"automatic_reexecution":false});
        let finished = prepared
            .run(
                operation.operation_id.as_str(),
                args.timeout_ms,
                cancellation.clone(),
            )
            .await
            .map_err(|e| {
                HandlerError::after_possible_effect(e.to_string(), Some(recovery.clone()))
            })?;
        let mut output = PluginBuildResult {
            operation_id: OperationId::new(operation.operation_id.as_str())
                .map_err(|e| HandlerError::before_effect(e.to_string()))?,
            revision: args.revision,
            artifact: None,
            process: finished.report.clone(),
            diagnostic: None,
        };
        let mut outcome = match finished.report.termination {
            ProcessTermination::Cancelled => host::OperationOutcome::Cancelled,
            ProcessTermination::Uncertain => host::OperationOutcome::Uncertain,
            ProcessTermination::TimedOut => host::OperationOutcome::Failed,
            ProcessTermination::Exited if finished.report.exit_code == Some(0) => {
                host::OperationOutcome::Succeeded
            }
            ProcessTermination::Exited => host::OperationOutcome::Failed,
        };
        if outcome == host::OperationOutcome::Succeeded {
            let candidate = tokio::task::spawn_blocking(move || {
                let archive = finished.archive()?;
                finished.record_candidate(&archive.artifacts[0].id)?;
                Ok::<_, PluginError>(archive)
            })
            .await
            .map_err(|e| {
                HandlerError::after_possible_effect(e.to_string(), Some(recovery.clone()))
            })?;
            match candidate {
                Err(fault) => {
                    outcome = host::OperationOutcome::Failed;
                    output.diagnostic = Some(fault.to_string());
                }
                Ok(archive) => {
                    if *cancellation.borrow() {
                        outcome = host::OperationOutcome::Cancelled;
                    } else {
                        let artifact = archive.artifacts[0].id.clone();
                        let repository = self.service.repository.clone();
                        let committed = tokio::task::spawn_blocking(move || {
                            commit_build(&repository, &archive)
                        })
                        .await
                        .map_err(|e| {
                            HandlerError::after_possible_effect(
                                e.to_string(),
                                Some(recovery.clone()),
                            )
                        })?;
                        match committed {
                            Ok(()) => output.artifact = Some(artifact),
                            Err(PluginError::Invalid(message)) => {
                                outcome = host::OperationOutcome::Failed;
                                output.diagnostic = Some(message);
                            }
                            Err(fault) => {
                                return Err(HandlerError::after_possible_effect(
                                    fault.to_string(),
                                    Some(recovery.clone()),
                                ));
                            }
                        }
                    }
                }
            }
        }
        if outcome != host::OperationOutcome::Succeeded && output.diagnostic.is_none() {
            output.diagnostic = Some(format!(
                "Build stopped: {:?}, exit code {:?}",
                output.process.termination, output.process.exit_code
            ));
        }
        let mut plan = CommitPlan::succeeded(json!(output));
        plan.outcome = outcome;
        if outcome != host::OperationOutcome::Succeeded {
            plan.error = output.diagnostic;
            plan.recovery = Some(recovery);
        }
        Ok(plan)
    }
}
struct BuildLease {
    service: Arc<PluginService>,
    operation: host::OperationId,
    revision: RevisionId,
    _permit: Option<OwnedSemaphorePermit>,
}
#[async_trait]
impl ExecutionLease for BuildLease {
    async fn completed(&mut self, result: &Result<host::OperationRecord, OperationError>) {
        if result.as_ref().is_ok_and(|record| {
            record.status.is_terminal() && record.status != host::OperationStatus::Uncertain
        }) {
            let _ = self.service.repository.lock().unwrap().release_reference(
                "build",
                self.operation.as_str(),
                &self.revision,
            );
        }
    }
}
