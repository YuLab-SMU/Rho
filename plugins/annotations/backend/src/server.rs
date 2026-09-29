use crate::metadata::{Failure, Metadata};
use rho_plugin_sdk::{BackendConnection, host_call_channel, protocol::*, validate_settlement};
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
struct Retained {
    request: RequestId,
    binding: ProviderBinding,
    outcome: Option<PluginOutcome>,
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
        Ok(output) => PluginCommitPlan {
            outcome: PluginOutcome::Succeeded,
            output: Some(output),
            error: None,
            recovery: None,
            facts: vec![],
            evidence: vec![],
            cancellation_confirmed: false,
        },
        Err(failure) => PluginCommitPlan {
            outcome: if failure.code == "annotation_storage_unavailable" {
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
pub async fn serve<R, W>(mut connection: BackendConnection<R, W>) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    for id in ["views.caller", "plugins.inspect"] {
        if !connection
            .grants
            .iter()
            .any(|g| g.capability == crate::manifest::key(id) && g.scopes.contains("plugins.read"))
        {
            return Err(format!("Annotations require an explicit {id} grant"));
        }
    }
    let instance = connection.instance.clone();
    let metadata = Arc::new(Metadata::new(
        instance.clone(),
        connection
            .environment
            .clone()
            .ok_or("Annotations require native instance storage")?,
        connection.grants.clone(),
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
    let mut queries: BTreeSet<RequestId> = BTreeSet::new();
    let mut retained: BTreeMap<OperationId, Retained> = BTreeMap::new();
    let mut settled: VecDeque<OperationSettlement> = VecDeque::new();
    let result = loop {
        tokio::select! {
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok((request, operation, output))) = completed else { break Err("Annotation work lost its confirmed result".into()); };
                let body = if let Some(operation) = operation {
                    let Some(entry) = retained.get_mut(&operation) else { break Err("Annotation result lost its original Operation".into()); };
                    let commit = plan(output);
                    entry.outcome = Some(commit.outcome);
                    RpcBody::CommitPlan(commit)
                } else {
                    if !queries.remove(&request) { break Err("Annotation result lost its original query".into()); }
                    match output { Ok(data) => RpcBody::QueryResult { data, completeness: ObservationCompleteness::Complete, source: None }, Err(failure) => failure.body() }
                };
                if let Err(error) = writer.send(request, body).await { break Err(error.to_string()); }
            },
            outgoing = pump.next() => {
                let Some(outgoing) = outgoing else { break Err("Annotation Host call pump ended".into()); };
                let RpcBody::HostCall { parent_request, .. } = &outgoing.body else { unreachable!() };
                if !queries.contains(parent_request) && !retained.values().any(|e| &e.request == parent_request && e.outcome.is_none()) { break Err("Source observation has no active parent".into()); }
                if let Err(error) = writer.send(outgoing.request, outgoing.body).await { break Err(error.to_string()); }
            },
            next = incoming.recv() => {
                let frame = match next { Some(Ok(Some(frame))) => frame, Some(Err(error)) => break Err(error), _ => break Ok(()) };
                if pump.contains(&frame.request) {
                    if let Err(error) = pump.respond(&frame.request, frame.body) { break Err(error.to_string()); }
                    continue;
                }
                let request = frame.request;
                let operation = matches!(&frame.body, RpcBody::Invoke(_));
                let reply = match frame.body {
                    RpcBody::Query(call) | RpcBody::Invoke(call) => {
                        if let Err(failure) = metadata.validate(&request, &call, operation) { Some(failure.body()) }
                        else if queries.contains(&request) || retained.values().any(|e| e.request == request) { break Err("Original annotation request is still retained".into()); }
                        else if queries.len() + retained.len() >= CAPACITY { Some(error("busy", "Annotation capacity reached; inspect original Operations")) }
                        else {
                            let id = if operation {
                                let id = match OperationId::new(call.operation_id.as_ref().unwrap()) { Ok(id) => id, Err(error) => break Err(error.to_string()) };
                                if retained.contains_key(&id) || settled.iter().any(|s| s.operation_id == id) { break Err("Original annotation Operation was dispatched twice".into()); }
                                retained.insert(id.clone(), Retained { request: request.clone(), binding: call.binding.clone(), outcome: None });
                                Some(id)
                            } else { queries.insert(request.clone()); None };
                            let metadata = metadata.clone(); let host = host.clone(); let request = request.clone();
                            jobs.spawn(async move { let result = metadata.execute(&call, &host).await; (request, id, result) });
                            None
                        }
                    },
                    RpcBody::OperationSettled(settlement) => {
                        if let Err(error) = validate_settlement(&instance, &settlement) { break Err(error.to_string()); }
                        if let Some(entry) = retained.get(&settlement.operation_id) {
                            if entry.binding != settlement.binding || entry.outcome.is_none()
                                || (settlement.outcome == PluginOutcome::Succeeded && entry.outcome != Some(PluginOutcome::Succeeded))
                                || settlement.outcome == PluginOutcome::Cancelled { break Err("Annotation settlement differs from the submitted original result".into()); }
                            retained.remove(&settlement.operation_id);
                        } else if settled.iter().any(|old| old.operation_id == settlement.operation_id && old != &settlement) { break Err("Repeated annotation settlement changed".into()); }
                        if !settled.contains(&settlement) { settled.push_back(settlement.clone()); if settled.len() > 128 { settled.pop_front(); } }
                        Some(RpcBody::SettlementAcknowledged(settlement))
                    },
                    RpcBody::Release if queries.is_empty() && retained.is_empty() && jobs.is_empty() && pump.pending() == 0 => {
                        if let Err(error) = writer.send(request, RpcBody::Released).await { break Err(error.to_string()); }
                        break Ok(());
                    },
                    RpcBody::Release => Some(error("busy", "Annotation work still awaits its original Host settlement")),
                    RpcBody::HostResult { .. } | RpcBody::Error { .. } => break Err("Uncorrelated annotation Host response".into()),
                    _ => Some(error("unsupported", "Annotations support declared queries and metadata Operations")),
                };
                if let Some(reply) = reply { if let Err(error) = writer.send(request, reply).await { break Err(error.to_string()); } }
            },
        }
    };
    pump.close();
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    reader_task.abort();
    let _ = reader_task.await;
    result
}
