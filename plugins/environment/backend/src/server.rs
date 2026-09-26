use crate::{
    host_reads::{HostReads, ReadRequest},
    owner::{Owner, failed},
    source,
};
use rho_plugin_sdk::{BackendConnection, ResourceClient, protocol::*, validate_settlement};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, watch},
    task::JoinSet,
};
fn error(code: &str, message: impl Into<String>) -> RpcBody {
    RpcBody::Error {
        code: code.into(),
        message: message.into(),
        recovery: None,
    }
}
pub async fn serve<R, W>(mut connection: BackendConnection<R, W>) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    for (id, scope) in [
        ("operation.get", "operation.read"),
        ("resources.read", "resources.read"),
    ] {
        if !connection.grants.iter().any(|grant| {
            grant.capability.id.as_str() == id
                && grant.capability.version == 1
                && grant.scopes.contains(scope)
        }) {
            return Err(format!(
                "Environment requires an explicit {id} grant with {scope}"
            ));
        }
    }
    let (read_sender, mut reads) = mpsc::channel::<ReadRequest>(32);
    let host = HostReads(read_sender);
    let owner = Arc::new(Owner::new(
        connection
            .environment
            .clone()
            .ok_or("Native environment is required")?,
        connection.instance.configuration.clone(),
        ResourceClient::new(
            connection
                .resource_channel
                .clone()
                .ok_or("Resource channel is required")?,
        )
        .map_err(|e| e.to_string())?,
        host.clone(),
    )?);
    connection.ready().await.map_err(|e| e.to_string())?;
    let instance = connection.instance.clone();
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
    let mut cancellations: BTreeMap<String, (watch::Sender<bool>, bool)> = BTreeMap::new();
    let mut observations: BTreeMap<RequestId, ReadRequest> = BTreeMap::new();
    let mut active = BTreeSet::new();
    let mut query_requests = BTreeSet::new();
    let mut serial = 0u64;
    let result = loop {
        tokio::select! {
            read = reads.recv() => {
                let Some(read) = read else { break Err("Environment reverse-query channel ended".into()); };
                if read.reply.is_closed() { continue; }
                if !active.contains(&read.parent) || observations.len() >= 32 {
                    let _ = read.reply.send(Err("Host read parent is inactive or observation capacity is exhausted".into()));
                    continue;
                }
                let reverse = loop {
                    serial = serial.checked_add(1).ok_or("Environment request counter exhausted")?;
                    let candidate = RequestId::new(format!("environment-read-{serial}")).unwrap();
                    if !observations.contains_key(&candidate) && !active.contains(&candidate) { break candidate; }
                };
                if let Err(e) = writer.send(reverse.clone(), RpcBody::HostCall { parent_request:read.parent.clone(), capability:read.capability.clone(), arguments:read.arguments.clone() }).await { break Err(e.to_string()); }
                observations.insert(reverse,read);
            },
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok((request, operation, reply))) = completed else { break Err("Environment task ended without a confirmed result".into()); };
                if let Some(operation) = operation { cancellations.remove(&operation); }
                query_requests.remove(&request); active.remove(&request);
                if let Err(e) = writer.send(request,reply).await { break Err(e.to_string()); }
            },
            next = incoming.recv() => {
                let frame = match next { Some(Ok(Some(frame))) => frame, Some(Err(e)) => break Err(e), _ => break Ok(()) };
                if let Some(read) = observations.remove(&frame.request) {
                    let response = match frame.body { RpcBody::HostResult { result } => Ok(result), RpcBody::Error { code, message, .. } => Err(format!("{code}: {message}")), _ => break Err("Expected a correlated Host observation".into()) };
                    let _ = read.reply.send(response); continue;
                }
                let operation_message = matches!(&frame.body,RpcBody::Invoke(_));
                let reply = match frame.body {
                    RpcBody::Query(call) | RpcBody::Invoke(call) => {
                        if call.request != frame.request || call.binding.provider != instance.identity || call.binding.project != instance.project
                            || call.principal != instance.principal || operation_message != call.operation_id.is_some() { break Err("Environment call differs from its initialized identity or original owner".into()); }
                        if active.contains(&call.request) { break Err("Environment request is already in flight".into()); }
                        if operation_message {
                            let operation = call.operation_id.as_ref().unwrap();
                            if owner.contains(operation) { break Err("Original Environment operation was dispatched twice".into()); }
                            match owner.admit(&call) {
                                Err(message) => Some(RpcBody::CommitPlan(failed(message))),
                                Ok(()) => {
                                    let operation = operation.clone();
                                    let (cancel,cancellation) = watch::channel(false);
                                    cancellations.insert(operation.clone(),(cancel,call.binding.capability.id.as_str() != source::RECONCILE));
                                    active.insert(call.request.clone()); let owner=owner.clone();
                                    jobs.spawn(async move { let plan=owner.execute(&call,cancellation).await; (call.request,Some(operation),RpcBody::CommitPlan(plan)) }); None
                                },
                            }
                        } else if query_requests.len() >= 16 { Some(error("busy","Environment observation capacity reached; retry this read")) }
                        else {
                            active.insert(call.request.clone()); query_requests.insert(call.request.clone());
                            let owner=owner.clone(); let host=host.clone();
                            jobs.spawn(async move {
                                let result = async { match owner.source_request(&call)? {
                                    Some(operation) => owner.complete_source(&call,host.query(call.request.clone(),"operation.get",json!({"operation_id":operation})).await?).await,
                                    None => owner.query(&call).await,
                                }}.await;
                                let reply=match result { Ok(data) => RpcBody::QueryResult { data, completeness:if call.binding.capability.id.as_str() == source::OBSERVE { ObservationCompleteness::Partial } else { ObservationCompleteness::Complete }, source:None }, Err(message) => error("invalid_environment_query",message) };
                                (call.request,None,reply)
                            }); None
                        }
                    },
                    RpcBody::Cancel { operation_id } => {
                        if let Some((cancel,true))=cancellations.get(&operation_id) { cancel.send_replace(true); }
                        Some(RpcBody::CancelAcknowledged { operation_id,confirmed:false })
                    },
                    RpcBody::OperationSettled(settlement) => {
                        if let Err(e)=validate_settlement(&instance,&settlement) { break Err(e.to_string()); }
                        Some(if cancellations.contains_key(settlement.operation_id.as_str()) { error("settlement","Native Environment has not returned its original result") }
                        else { match owner.settle(&settlement) { Ok(()) => RpcBody::SettlementAcknowledged(settlement), Err(message) => error("settlement",message) } })
                    },
                    RpcBody::Release => {
                        if !jobs.is_empty() || !observations.is_empty() || !owner.ready_to_release() { Some(error("busy","Original Environment calls and settlements must finish before release")) }
                        else { break writer.send(frame.request,RpcBody::Released).await.map_err(|e|e.to_string()); }
                    },
                    _ => Some(error("unsupported","Unexpected Environment protocol message")),
                };
                if let Some(reply)=reply { if let Err(e)=writer.send(frame.request,reply).await { break Err(e.to_string()); } }
            }
        }
    };
    reader_task.abort();
    // Wake queued reads and stop unstarted work; never manufacture a journal result.
    drop(observations);
    drop(reads);
    for (cancellation, _) in cancellations.values() {
        cancellation.send_replace(true);
    }
    while jobs.join_next().await.is_some() {}
    result
}
