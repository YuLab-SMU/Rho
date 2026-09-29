//! Ordinary model tasks retain their native admission for the entire model loop.
//! The public owner and store remain the sole task state machine and event log.
use crate::tools::{RunPort, validate_selection};
use crate::{
    arguments::*,
    metadata::{Failure, Metadata, decode, encoded, now},
};
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
            "agent.model.history" => {
                let args: ModelHistory = decode(&call.arguments)?;
                if args.conversation_id.is_empty()
                    || args.conversation_id.len() > 160
                    || !(1..=20).contains(&args.limit)
                    || args
                        .before
                        .as_ref()
                        .is_some_and(|id| id.is_empty() || id.len() > 160)
                {
                    return Err(Failure::invalid("Invalid model history page bounds"));
                }
                let live = self.live_ids()?;
                let mut rows = metadata.owner.store.component_run_history(
                    &metadata.scope,
                    &args.conversation_id,
                    args.before.as_deref(),
                    args.limit as usize + 1,
                )?;
                let more = rows.len() > args.limit as usize;
                rows.truncate(args.limit as usize);
                let next = more.then(|| rows.last().unwrap().0.run_id.clone());
                let runs = rows.into_iter().map(|(mut run, incarnation)| {
                    if !run.state.is_terminal() && (incarnation != metadata.owner.host_incarnation || !live.contains(&run.run_id)) {
                        run.state = ComponentAgentRunState::Interrupted;
                        run.reason = Some("The original model loop is no longer owned by this process; inspect its original records before continuing".into());
                    }
                    run
                }).collect();
                encoded(ModelHistoryPage {
                    conversation_id: args.conversation_id,
                    runs,
                    next,
                })
            }
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
            "agent.model.run.admission" => {
                let args: ModelRun = decode(&call.arguments)?;
                let origin = self
                    .stored(metadata, &args.run_id)?
                    .native_origin
                    .ok_or_else(|| {
                        Failure::invalid("This task has no original native admission")
                    })?;
                encoded(ModelAdmission {
                    operation: origin.operation,
                    request: origin.request,
                    binding: origin.binding,
                    r: origin.r,
                })
            }
            "agent.model.run.tools" => {
                let args: ModelRun = decode(&call.arguments)?;
                self.stored(metadata, &args.run_id)?;
                encoded(
                    metadata
                        .owner
                        .store
                        .component_tools(&metadata.scope, &args.run_id)?
                        .into_iter()
                        .map(|tool| tool.receipt)
                        .collect::<Vec<_>>(),
                )
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
        host: rho_plugin_sdk::HostCallClient,
    ) -> Result<Value, Failure> {
        let args: RunModel = decode(&call.arguments)?;
        let at = now();
        let actor = metadata.actor(caller, at);
        let mode = args
            .mode
            .map(Into::into)
            .unwrap_or(ComponentAgentMode::Explain);
        let selected_r = args.r;
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
                mode,
                permission_policy: None,
                session: selected_r.as_ref().map(|binding| ComponentAgentSession {
                    workspace_instance_id: binding.provider.instance.to_string(),
                    session_id: binding.target.clone().unwrap_or_default(),
                }),
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
                r: selected_r.clone(),
            };
        let (admitted, guard, captured_key) = {
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
            let captured_key = if !repeated {
                validate_selection(metadata, call, selected_r.as_ref(), mode)?;
                let settings = metadata.owner.store.component_settings(&metadata.scope)?;
                if settings.version != request.model_settings_version {
                    return Err(ComponentTaskError::Conflict.into());
                }
                if !settings.enabled {
                    return Err(Failure::invalid("Choose and enable a model before sending"));
                }
                let connection = settings
                    .connection
                    .ok_or_else(|| Failure::invalid("Configure a model before sending"))?;
                // Capture before draft admission. A missing key must preserve
                // the draft; later removal cannot revoke bytes already captured
                // for this authorized Send. Immutable references and settings
                // CAS fence concurrent model replacement.
                Some(metadata.model_key(&connection.credential)?)
            } else {
                None
            };
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
                captured_key,
            )
        };
        let id = &admitted.run.run_id;
        let port = RunPort::new(metadata.clone(), &admitted, host)?;
        let prepared = async {
            let run = metadata.owner.claim(&metadata.scope, id, now())?.run;
            let context = port.context().await?;
            if guard.cancellation.is_cancelled() {
                return Err(Failure::invalid(
                    "Model task stopped before model admission",
                ));
            }
            let key = captured_key
                .ok_or_else(|| Failure::invalid("The captured model credential is unavailable"))?;
            Ok::<_, Failure>((run, key, context))
        }
        .await;
        let (state, reason) = match prepared {
            Err(error) => (
                if guard.cancellation.is_cancelled() {
                    ComponentAgentRunState::Stopped
                } else {
                    ComponentAgentRunState::Failed
                },
                Some(error.message),
            ),
            Ok((run, key, context)) => {
                let tools = port.specs(&run);
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
                        context,
                        images: vec![],
                        tools,
                        key,
                        port: port.clone(),
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
        port.settle_native().await;
        let final_run = self.stored(metadata, id)?;
        drop(guard);
        encoded(self.observe(metadata, final_run)?)
    }
}
