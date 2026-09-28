//! Ordinary model tasks retain their native admission for the entire model loop.
//! The public owner and store remain the sole task state machine and event log.
use crate::{
    arguments::*,
    metadata::{Failure, Metadata, decode, encoded, now},
};
use async_trait::async_trait;
use rho_agent_api::{component::*, *};
use rho_agent_engine::*;
use rho_agent_owner::component::{
    ComponentNativeRunOrigin, ComponentTaskError, MAX_COMPONENT_RUNNING_RUNS, StoredComponentRun,
};
use rho_plugin_sdk::protocol::{PluginCall, PluginViewCaller};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Runs {
    engine: RigAgentEngine,
    live: Mutex<BTreeMap<String, CancellationToken>>,
}
struct Live<'a> {
    runs: &'a Runs,
    id: String,
    cancellation: CancellationToken,
}
impl Drop for Live<'_> {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Ok(mut live) = self.runs.live.lock() {
            live.remove(&self.id);
        }
    }
}
fn unavailable() -> Failure {
    Failure {
        code: "unavailable",
        message: "Original model task state is unavailable".into(),
    }
}
impl Runs {
    pub fn live_ids(&self) -> Result<Vec<String>, Failure> {
        Ok(self
            .live
            .lock()
            .map_err(|_| unavailable())?
            .keys()
            .cloned()
            .collect())
    }
    pub fn cancel(&self, id: &str) {
        if let Ok(live) = self.live.lock()
            && let Some(token) = live.get(id)
        {
            token.cancel();
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(live) = self.live.lock() {
            for token in live.values() {
                token.cancel();
            }
        }
    }
    fn observe(
        &self,
        metadata: &Metadata,
        stored: StoredComponentRun,
    ) -> Result<ComponentAgentRun, Failure> {
        let mut run = metadata.owner.observed_run(stored);
        if !run.state.is_terminal()
            && !self
                .live
                .lock()
                .map_err(|_| unavailable())?
                .contains_key(&run.run_id)
        {
            run.state = ComponentAgentRunState::Interrupted;
            run.reason = Some("The original model loop is no longer owned by this process; inspect its original records before continuing".into());
        }
        Ok(run)
    }
    fn stored(&self, metadata: &Metadata, id: &str) -> Result<StoredComponentRun, Failure> {
        if id.is_empty() || id.len() > 160 {
            return Err(Failure::invalid("Invalid original run identity"));
        }
        Ok(metadata
            .owner
            .store
            .component_run(&metadata.scope, id)?
            .ok_or(ComponentTaskError::NotFound)?)
    }
    pub fn read(&self, metadata: &Metadata, call: &PluginCall) -> Result<Value, Failure> {
        match call.binding.capability.id.as_str() {
            "agent.model.run.get" => {
                let args: ModelRun = decode(&call.arguments)?;
                encoded(self.observe(metadata, self.stored(metadata, &args.run_id)?)?)
            }
            "agent.model.run.request" => {
                let args: CredentialRequest = decode(&call.arguments)?;
                if args.request_id.is_empty() || args.request_id.len() > 160 {
                    return Err(Failure::invalid("Invalid original request identity"));
                }
                let stored = metadata
                    .owner
                    .store
                    .component_run_by_request(&metadata.scope, &args.request_id)?
                    .ok_or(ComponentTaskError::NotFound)?;
                encoded(self.observe(metadata, stored)?)
            }
            "agent.model.run.events" => {
                let args: ModelEvents = decode(&call.arguments)?;
                if !(1..=100).contains(&args.limit) {
                    return Err(Failure::invalid("Invalid event page bounds"));
                }
                self.stored(metadata, &args.run_id)?;
                encoded(metadata.owner.store.component_events(
                    &metadata.scope,
                    &args.run_id,
                    args.after,
                    args.limit as usize,
                )?)
            }
            _ => Err(Failure::invalid("Unknown model task query")),
        }
    }
    pub fn stop(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let args: ModelRun = decode(&call.arguments)?;
        let at = now();
        let actor = metadata.actor(caller, at);
        let run = metadata.owner.stop(&actor, &args.run_id, at)?;
        self.cancel(&args.run_id);
        // Requested stop and the eventual original model outcome are distinct.
        encoded(self.observe(metadata, run)?)
    }
    pub async fn start(
        &self,
        metadata: &Arc<Metadata>,
        call: &PluginCall,
        caller: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let args: RunModel = decode(&call.arguments)?;
        let at = now();
        let actor = metadata.actor(caller, at);
        let request = ComponentAgentStart {
            request_id: args.request_id,
            conversation_id: args.conversation_id,
            conversation_version: args.conversation_version,
            model_settings_version: args.model_settings_version,
            window: actor.window().clone(),
            text: args.text,
            sources: vec![],
            assets: None,
            continuation: None,
            grant: ComponentAgentGrant {
                mode: ComponentAgentMode::Explain,
                permission_policy: None,
                session: None,
                documents: vec![],
                files: vec![],
            },
        };
        let origin =
            ComponentNativeRunOrigin {
                operation: OperationId::new(call.operation_id.as_deref().ok_or_else(|| {
                    Failure::invalid("A model task requires its native Operation")
                })?)
                .map_err(|_| Failure::invalid("Invalid native Operation identity"))?,
                request: call.request.clone(),
                binding: call.binding.clone(),
            };
        let (admitted, guard) = {
            let mut live = self.live.lock().map_err(|_| unavailable())?;
            let repeated = metadata
                .owner
                .store
                .component_run_by_request(&metadata.scope, &request.request_id)?
                .is_some();
            if !repeated && live.len() >= MAX_COMPONENT_RUNNING_RUNS {
                return Err(Failure {
                    code: "busy",
                    message: "Model task slots are occupied; inspect or stop the original tasks"
                        .into(),
                });
            }
            let admitted = metadata.owner.start_native(&actor, request, origin, at)?;
            if admitted.repeated {
                drop(live);
                return encoded(self.observe(metadata, admitted.run)?);
            }
            let cancellation = CancellationToken::new();
            let id = admitted.run.run.run_id.clone();
            live.insert(id.clone(), cancellation.clone());
            (
                admitted.run,
                Live {
                    runs: self,
                    id,
                    cancellation,
                },
            )
        };
        let id = &admitted.run.run_id;
        let prepared = (|| {
            let key = metadata.model_key(&admitted.run.model.credential)?;
            let run = metadata.owner.claim(&metadata.scope, id, now())?.run;
            Ok::<_, Failure>((run, key))
        })();
        let (state, reason) = match prepared {
            Err(error) => (ComponentAgentRunState::Failed, Some(error.message)),
            Ok((run, key)) => {
                let outcome = self
                    .engine
                    .execute(AgentModelExecution {
                        run: AgentModelRun {
                            run_id: run.run_id,
                            profile: run.profile,
                            model: run.model,
                            budget: run.budget,
                            created_at_ms: run.created_at_ms,
                            text: run.request.text,
                            permission_policy: run.request.grant.permission_policy,
                            task_intent: run.task_intent,
                        },
                        context: String::new(),
                        images: vec![],
                        tools: vec![],
                        key,
                        port: Arc::new(Port {
                            metadata: metadata.clone(),
                            run: id.clone(),
                        }),
                        cancellation: guard.cancellation.clone(),
                    })
                    .await;
                if guard.cancellation.is_cancelled() {
                    (
                        ComponentAgentRunState::Stopped,
                        Some("Model task stopped".into()),
                    )
                } else {
                    match outcome {
                        AgentModelOutcome::Completed => (ComponentAgentRunState::Completed, None),
                        AgentModelOutcome::Stopped => (
                            ComponentAgentRunState::Stopped,
                            Some("Model task stopped".into()),
                        ),
                        AgentModelOutcome::Failed(reason) => {
                            (ComponentAgentRunState::Failed, Some(reason))
                        }
                    }
                }
            }
        };
        let current = self.stored(metadata, id)?;
        // Explicit controller takeover can already have fenced and interrupted it.
        if !current.run.state.is_terminal() {
            metadata
                .owner
                .finish(&metadata.scope, id, state, reason, now())?;
        }
        let final_run = self.stored(metadata, id)?;
        drop(guard);
        encoded(self.observe(metadata, final_run)?)
    }
}

struct Port {
    metadata: Arc<Metadata>,
    run: String,
}
impl Port {
    fn diagnosed<T>(&self, value: Result<T, ComponentTaskError>) -> Result<T, String> {
        value.map_err(|error| {
            let original = match &error {
                ComponentTaskError::Diagnostic(diagnostic) => Some((**diagnostic).clone()),
                _ => None,
            };
            let failure = Failure::from(error);
            let diagnostic = original.unwrap_or_else(|| Diagnostic {
                code: match failure.code {
                    "agent_storage_unavailable" => DiagnosticCode::OutcomeUncertain,
                    "invalid_input" => DiagnosticCode::InvalidInput,
                    "budget_exceeded" => DiagnosticCode::BudgetExceeded,
                    "access_denied" => DiagnosticCode::AccessDenied,
                    "request_conflict" => DiagnosticCode::IdempotencyConflict,
                    "conflict" => DiagnosticCode::ContentChanged,
                    _ => DiagnosticCode::Unavailable,
                },
                message: failure.message.clone(),
                continuation: DiagnosticContinuation::InspectOriginal,
                next_reads: vec![],
            });
            let _ = self.metadata.owner.record_diagnostic(
                &self.metadata.scope,
                &self.run,
                diagnostic,
                now(),
            );
            failure.message
        })
    }
}
#[async_trait]
impl AgentModelPort for Port {
    async fn begin_model_call(&self) -> Result<u32, String> {
        self.diagnosed(
            self.metadata
                .owner
                .begin_model_call(&self.metadata.scope, &self.run, now()),
        )
    }
    async fn prepare_tool(
        &self,
        _: u32,
        _: &str,
        _: &str,
        _: Value,
    ) -> Result<AgentToolAdmission, String> {
        self.diagnosed(Err(ComponentTaskError::InvalidInput(
            "This model task has no authorized native tools".into(),
        )))
    }
    async fn execute_tool(&self, _: AgentToolTicket) -> Result<Value, String> {
        self.diagnosed(Err(ComponentTaskError::InvalidInput(
            "No native tool was admitted".into(),
        )))
    }
    async fn interrupted_tool(&self, _: &AgentToolTicket) -> Result<(), String> {
        self.diagnosed(Err(ComponentTaskError::InvalidInput(
            "No original native tool receipt exists".into(),
        )))
    }
    async fn append_text(&self, text: String) -> Result<(), String> {
        self.diagnosed(self.metadata.owner.append_text(
            &self.metadata.scope,
            &self.run,
            text,
            now(),
        ))
    }
    async fn record_usage(&self, input: Option<u64>, output: Option<u64>) -> Result<(), String> {
        self.diagnosed(self.metadata.owner.record_usage(
            &self.metadata.scope,
            &self.run,
            input,
            output,
            now(),
        ))
    }
}
