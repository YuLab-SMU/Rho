use crate::{
    manifest,
    metadata::{Failure, Metadata},
};
use rho_plugin_sdk::{
    BackendConnection, HostCallError, host_call_channel, protocol::*, validate_settlement,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc,
    task::JoinSet,
};

const CAPACITY: usize = 16;
const HISTORY: usize = 128;

struct Retained {
    request: RequestId,
    binding: ProviderBinding,
    outcome: Option<PluginOutcome>,
}
enum Completed {
    Query(RequestId, String, Result<Value, Failure>),
    Operation(OperationId, PluginCommitPlan),
    Control(RequestId, Result<Value, Failure>),
}

fn error(code: &str, message: &str) -> RpcBody {
    RpcBody::Error {
        code: code.into(),
        message: message.into(),
        recovery: None,
    }
}
fn plan(result: Result<Value, Failure>) -> PluginCommitPlan {
    match result {
        Ok(data) => PluginCommitPlan {
            outcome: PluginOutcome::Succeeded,
            output: Some(data),
            error: None,
            recovery: None,
            facts: vec![],
            evidence: vec![],
            cancellation_confirmed: false,
        },
        Err(failure) => PluginCommitPlan {
            outcome: if matches!(
                failure.code,
                "agent_storage_unavailable" | "native_outcome_uncertain"
            ) {
                PluginOutcome::Uncertain
            } else {
                PluginOutcome::Failed
            },
            output: None,
            error: Some(failure.message),
            recovery: Some(json!({"code":failure.code})),
            facts: vec![],
            evidence: vec![],
            cancellation_confirmed: false,
        },
    }
}
pub(crate) fn caller(result: Result<Value, HostCallError>) -> Result<PluginViewCaller, Failure> {
    let value = result.map_err(|_| Failure {
        code: "caller_unavailable",
        message: "The original caller could not be observed; no Agent action was dispatched".into(),
    })?;
    if value["status"] != "ready" || value["completeness"] != "complete" {
        return Err(Failure::invalid(
            "The original caller observation is incomplete",
        ));
    }
    // Missing data/view is never silently interpreted as a non-view caller.
    let data = value
        .get("data")
        .filter(|data| data.get("view").is_some())
        .ok_or_else(|| Failure::invalid("The original caller observation has no identity"))?;
    crate::metadata::decode(data)
}

/// One reader and writer own framed I/O. Metadata admission uses the same bounded
/// reverse-call transport later used by model callbacks. Pending mutation replies
/// and settlement acknowledgements remain distinct until the Host commits.
pub async fn serve<R, W>(connection: BackendConnection<R, W>) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    serve_with_native_factory(connection, Arc::new(rho_agent_client::LocalNativeAgents)).await
}
/// The same production composition with an explicit native adapter, used by
/// deterministic framed tests without invoking installed Agents or user keys.
pub async fn serve_with_native_factory<R, W>(
    mut connection: BackendConnection<R, W>,
    factory: Arc<dyn rho_agent_client::NativeAgentFactory>,
) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    for capability in ["views.caller", "views.presence"] {
        if !connection.grants.iter().any(|grant| {
            grant.capability == manifest::key(capability) && grant.scopes.contains("plugins.read")
        }) {
            return Err(format!(
                "Agent requires an explicit {capability} grant with plugins.read"
            ));
        }
    }
    let instance = connection.instance.clone();
    let metadata = Arc::new(Metadata::new(
        instance.clone(),
        connection
            .environment
            .clone()
            .ok_or("Agent requires native instance storage")?,
        connection.grants.clone(),
        factory,
    )?);
    let (host, mut pump) = host_call_channel(CAPACITY).map_err(|e| e.to_string())?;
    connection.ready().await.map_err(|e| e.to_string())?;
    let (sender, mut incoming) = mpsc::channel(32);
    let mut reader = connection.reader;
    let reader_task = tokio::spawn(async move {
        loop {
            let frame = reader.receive().await.map_err(|e| e.to_string());
            let end = !matches!(&frame, Ok(Some(_)));
            if sender.send(frame).await.is_err() || end {
                break;
            }
        }
    });
    let mut writer = connection.writer;
    let mut jobs = JoinSet::new();
    let mut retained: BTreeMap<OperationId, Retained> = BTreeMap::new();
    let mut controls: BTreeSet<RequestId> = BTreeSet::new();
    let mut queries: BTreeSet<RequestId> = BTreeSet::new();
    let mut settled: VecDeque<OperationSettlement> = VecDeque::new();
    let result = loop {
        tokio::select! {
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok(completed)) = completed else {
                    break Err("Agent work ended without a confirmed result".into());
                };
                let (request, body) = match completed {
                    Completed::Operation(operation, output) => {
                        let Some(entry) = retained.get_mut(&operation) else {
                            break Err("Agent result lost its original operation".into());
                        };
                        entry.outcome = Some(output.outcome);
                        (entry.request.clone(), RpcBody::CommitPlan(output))
                    },
                    Completed::Query(request, capability, result) => {
                        if !queries.remove(&request) { break Err("Agent query lost its original request".into()); }
                        let body = match result {
                            Ok(data) => {
                                let incomplete = (capability == "agent.model.key.receipt" && data["credential"].is_null())
                                    || (matches!(capability.as_str(), "agent.model.tool.operation" | "agent.native.tool.operation") && data["completeness"] != "complete");
                                RpcBody::QueryResult { data, completeness: if incomplete { ObservationCompleteness::Partial } else { ObservationCompleteness::Complete }, source: None }
                            },
                            Err(error) => error.body(),
                        };
                        (request, body)
                    },
                    Completed::Control(request, output) => {
                        if !controls.remove(&request) { break Err("Agent control lost its original request".into()); }
                        let body = match output {
                            Ok(data) => RpcBody::ControlResult { data },
                            Err(error) => error.body(),
                        };
                        (request, body)
                    },
                };
                if let Err(error) = writer.send(request, body).await {
                    break Err(error.to_string());
                }
            },
            // Jobs may enqueue their next Host call after this select begins.
            // Always listen, including while the queue is currently empty.
            outgoing = pump.next() => {
                let Some(outgoing) = outgoing else { break Err("Agent Host call pump ended".into()); };
                let RpcBody::HostCall { parent_request, .. } = &outgoing.body else { unreachable!() };
                if !queries.contains(parent_request) && !controls.contains(parent_request) && !retained.values().any(|entry| &entry.request == parent_request && entry.outcome.is_none()) {
                    break Err("Agent Host call has no active original parent".into());
                }
                if let Err(error) = writer.send(outgoing.request, outgoing.body).await { break Err(error.to_string()); }
            },
            next = incoming.recv() => {
                let frame = match next { Some(Ok(Some(frame))) => frame, Some(Err(error)) => break Err(error), _ => break Ok(()) };
                if pump.contains(&frame.request) {
                    if let Err(error) = pump.respond(&frame.request, frame.body) { break Err(error.to_string()); }
                    continue;
                }
                let request = frame.request;
                let kind = match &frame.body {
                    RpcBody::Invoke(_) => CapabilityKind::Operation,
                    RpcBody::Control(_) => CapabilityKind::Control,
                    _ => CapabilityKind::Query,
                };
                let reply = match frame.body {
                    RpcBody::Query(call) | RpcBody::Invoke(call) | RpcBody::Control(call) => {
                        if let Err(failure) = metadata.validate(&request, &call, kind) {
                            Some(failure.body())
                        } else if queries.contains(&request) || controls.contains(&request) || retained.values().any(|entry| entry.request == request) {
                            break Err("Original Agent request is still retained".into());
                        } else if kind == CapabilityKind::Query {
                            if queries.len() >= CAPACITY { Some(error("busy", "Agent observation capacity reached")) }
                            else {
                                queries.insert(request.clone());
                                let metadata = metadata.clone();
                                let host = host.clone();
                                let original = request.clone();
                                jobs.spawn(async move {
                                    let result = metadata.query(&call, host).await;
                                    Completed::Query(original, call.binding.capability.id.to_string(), result)
                                });
                                None
                            }
                        } else if retained.len() + controls.len() >= CAPACITY {
                            Some(error("busy", "Agent capacity reached; inspect original operations"))
                        } else {
                            let operation = if kind == CapabilityKind::Operation {
                                let id = match OperationId::new(call.operation_id.as_ref().unwrap()) {
                                    Ok(id) => id, Err(error) => break Err(error.to_string()),
                                };
                                if retained.contains_key(&id) || settled.iter().any(|entry| entry.operation_id == id) {
                                    break Err("Original Agent operation was dispatched twice".into());
                                }
                                Some(id)
                            } else { None };
                            let reverse = loop {
                                let candidate = RequestId::new(format!("agent-caller-{}", uuid::Uuid::new_v4())).unwrap();
                                if candidate != request && !pump.contains(&candidate) && !queries.contains(&candidate) && !controls.contains(&candidate)
                                    && !retained.values().any(|entry| entry.request == candidate) { break candidate; }
                            };
                            let pending = match host.begin(reverse, request.clone(), manifest::key("views.caller"), json!({})) {
                                Ok(pending) => pending,
                                Err(_) => {
                                    // Concurrent bounded observations can occupy the reverse
                                    // channel. Refuse only this admission, preserving active work.
                                    if let Err(error) = writer.send(request, error("busy", "Agent native observation capacity reached")).await {
                                        break Err(error.to_string());
                                    }
                                    continue;
                                },
                            };
                            let metadata = metadata.clone();
                            let host = host.clone();
                            if let Some(id) = operation {
                                retained.insert(id.clone(), Retained { request: request.clone(), binding: call.binding.clone(), outcome: None });
                                jobs.spawn(async move {
                                    let result = match caller(pending.receive().await) {
                                        Ok(origin) => metadata.dispatch(&call, origin, host).await,
                                        Err(error) => Err(error),
                                    };
                                    Completed::Operation(id, plan(result))
                                });
                            } else {
                                controls.insert(request.clone());
                                let original = request.clone();
                                jobs.spawn(async move {
                                    let result = match caller(pending.receive().await) {
                                        Ok(origin) => metadata.control(&call, origin).await,
                                        Err(error) => Err(error),
                                    };
                                    Completed::Control(original, result)
                                });
                            }
                            None
                        }
                    },
                    RpcBody::OperationSettled(settlement) => {
                        if let Err(error) = validate_settlement(&instance, &settlement) { break Err(error.to_string()); }
                        if let Some(entry) = retained.get(&settlement.operation_id) {
                            // Core may retain a failed/uncertain outcome after boundary
                            // validation. Only matching terminal success can retire a
                            // success candidate; other outcomes preserve uncertainty.
                            if entry.binding != settlement.binding || entry.outcome.is_none()
                                || (settlement.outcome == PluginOutcome::Succeeded && entry.outcome != Some(PluginOutcome::Succeeded))
                                || (settlement.outcome == PluginOutcome::Cancelled && entry.outcome != Some(PluginOutcome::Cancelled)) {
                                break Err("Agent settlement differs from its original submitted result".into());
                            }
                            retained.remove(&settlement.operation_id);
                        } else if let Some(previous) = settled.iter().find(|entry| entry.operation_id == settlement.operation_id) {
                            if previous != &settlement { break Err("Repeated Agent settlement changed its original result".into()); }
                        }
                        // Core can settle work rejected before native admission (for
                        // example capacity) or cancelled before dispatch. No owner
                        // scheduler state exists to advance in that case. This exact
                        // Host-only notification never commits a result or replays it.
                        if !settled.contains(&settlement) {
                            settled.push_back(settlement.clone());
                            if settled.len() > HISTORY { settled.pop_front(); }
                        }
                        Some(RpcBody::SettlementAcknowledged(settlement))
                    },
                    RpcBody::Release if retained.is_empty() && controls.is_empty() && queries.is_empty() && jobs.is_empty() && pump.pending() == 0 => {
                        if let Err(failure) = metadata.close().await {
                            if let Err(error) = writer.send(request, failure.body()).await { break Err(error.to_string()); }
                            continue;
                        }
                        if let Err(error) = writer.send(request, RpcBody::Released).await { break Err(error.to_string()); }
                        break Ok(());
                    },
                    RpcBody::Release => Some(error("busy", "Agent operations still await their original Host settlement")),
                    RpcBody::HostResult { .. } | RpcBody::Error { .. } => break Err("Agent received an uncorrelated Host response".into()),
                    _ => Some(error("unsupported", "Agent does not support this message")),
                };
                if let Some(reply) = reply {
                    if let Err(error) = writer.send(request, reply).await { break Err(error.to_string()); }
                }
            },
        }
    };
    pump.close();
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    reader_task.abort();
    let _ = reader_task.await;
    let cleanup = metadata.close().await.map_err(|e| e.message);
    result.and(cleanup)
}
