use crate::owner::{Failure, Owner, failed};
use rho_plugin_sdk::{BackendConnection, protocol::*, validate_settlement};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};
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
fn failure(failure: Failure) -> RpcBody {
    error(failure.code, failure.message)
}

pub async fn serve<R, W>(mut connection: BackendConnection<R, W>) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let owner = Arc::new(Owner::new(
        connection
            .environment
            .clone()
            .ok_or("Host native environment is unavailable")?,
        connection.instance.configuration.clone(),
    )?);
    if !connection.grants.iter().any(|grant| {
        grant.capability.id.as_str() == "workspace.paths"
            && grant.capability.version == 1
            && grant.scopes.contains("project.read")
    }) {
        return Err("Files requires an explicit workspace.paths grant with project.read".into());
    }
    connection.ready().await.map_err(|e| e.to_string())?;
    let instance = connection.instance.clone();
    let (frames_tx, mut frames) = mpsc::channel(32);
    let mut reader = connection.reader;
    let reader_task = tokio::spawn(async move {
        loop {
            let result = reader.receive().await.map_err(|e| e.to_string());
            let end = !matches!(&result, Ok(Some(_)));
            if frames_tx.send(result).await.is_err() || end {
                break;
            }
        }
    });
    let mut writer = connection.writer;
    let mut jobs = JoinSet::new();
    let mut query_jobs = 0usize;
    let mut cancellations: BTreeMap<String, watch::Sender<bool>> = BTreeMap::new();
    let mut path_request: Option<(RequestId, PluginCall)> = None;
    let mut path_sequence = 0u64;
    let result = loop {
        tokio::select! {
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok((request, operation, reply))) = completed else { break Err("Files task ended without a result; native outcome is unconfirmed".into()); };
                if let Some(operation) = operation { cancellations.remove(&operation); }
                else { query_jobs -= 1; }
                if let Err(error) = writer.send(request, reply).await { break Err(error.to_string()); }
            },
            incoming = frames.recv() => {
                let frame = match incoming { Some(Ok(Some(frame))) => frame, Some(Err(error)) => break Err(error), _ => break Ok(()) };
                if path_request.as_ref().is_some_and(|(request, _)| request == &frame.request) {
                    let (_, call) = path_request.take().unwrap();
                    let bound = match frame.body {
                        RpcBody::HostResult { result } => owner.bind_paths(&result),
                        RpcBody::Error { code, message, .. } => Err(format!("Host paths unavailable ({code}): {message}")),
                        _ => break Err("Expected the correlated Host path reply".into()),
                    };
                    if let Err(message) = bound {
                        if let Err(error) = writer.send(call.request, error("host_paths", message)).await { break Err(error.to_string()); }
                    } else {
                        query_jobs += 1;
                        let owner = owner.clone();
                        jobs.spawn(async move { let reply = query_reply(&owner, &call).await; (call.request, None, reply) });
                    }
                    continue;
                }
                let operation_message = matches!(&frame.body, RpcBody::Invoke(_));
                let reply = match frame.body {
                    RpcBody::Query(call) | RpcBody::Invoke(call) => {
                        if call.request != frame.request || call.binding.provider != instance.identity
                            || call.binding.project != instance.project || call.principal != instance.principal
                            || operation_message != call.operation_id.is_some() {
                            break Err("Files call differs from the initialized instance or original owner".into());
                        }
                        if let Err(fault) = owner.check_call(&call) {
                            Some(if operation_message { RpcBody::CommitPlan(failed(fault.message)) } else { failure(fault) })
                        } else if !operation_message && (query_jobs >= 16 || path_request.is_some()) {
                            Some(error("busy", "Files observation capacity reached; retry this read"))
                        } else if !operation_message && !owner.bound() {
                            path_sequence += 1;
                            let mut request = RequestId::new(format!("files-paths-{path_sequence}")).unwrap();
                            if request == call.request { path_sequence += 1; request = RequestId::new(format!("files-paths-{path_sequence}")).unwrap(); }
                            if let Err(error) = writer.send(request.clone(), RpcBody::HostCall {
                                parent_request: call.request.clone(), capability: CapabilityKey { id: ContributionId::new("workspace.paths").unwrap(), version: 1 }, arguments: json!({}),
                            }).await { break Err(error.to_string()); }
                            path_request = Some((request, call));
                            None
                        } else if operation_message {
                            match owner.admit(&call) {
                                Err(fault) if fault.code == "duplicate_operation" => break Err(fault.message),
                                Err(fault) => Some(RpcBody::CommitPlan(failed(fault.message))),
                                Ok(()) => {
                                    let operation = call.operation_id.clone().unwrap();
                                    let (cancel, cancellation) = watch::channel(false);
                                    cancellations.insert(operation.clone(), cancel);
                                    let owner = owner.clone();
                                    jobs.spawn(async move { let plan = owner.invoke(&call, cancellation).await; (call.request, Some(operation), RpcBody::CommitPlan(plan)) });
                                    None
                                },
                            }
                        } else {
                            query_jobs += 1;
                            let owner = owner.clone();
                            jobs.spawn(async move { let reply = query_reply(&owner, &call).await; (call.request, None, reply) });
                            None
                        }
                    },
                    RpcBody::Cancel { operation_id } => {
                        if let Some(cancel) = cancellations.get(&operation_id) { cancel.send_replace(true); }
                        Some(RpcBody::CancelAcknowledged { operation_id, confirmed: false })
                    },
                    RpcBody::OperationSettled(settlement) => {
                        if let Err(error) = validate_settlement(&instance, &settlement) { break Err(error.to_string()); }
                        if cancellations.contains_key(settlement.operation_id.as_str()) { Some(error("settlement", "Native patch has not returned its result")) }
                        else { Some(match owner.settle(&settlement) { Ok(()) => RpcBody::SettlementAcknowledged(settlement), Err(message) => error("settlement", message) }) }
                    },
                    RpcBody::Release => {
                        if !jobs.is_empty() || path_request.is_some() || !owner.ready_to_release() {
                            Some(error("busy", "Original Files calls and their settlements must finish before release"))
                        } else { break writer.send(frame.request, RpcBody::Released).await.map_err(|e| e.to_string()); }
                    },
                    _ => Some(error("unsupported", "Unexpected Host message")),
                };
                if let Some(reply) = reply {
                    if let Err(error) = writer.send(frame.request, reply).await { break Err(error.to_string()); }
                }
            },
        }
    };
    reader_task.abort();
    // Stop waiting work, await any already-started native patch, and never send
    // a made-up cancellation or rollback after transport loss.
    for cancellation in cancellations.values() {
        cancellation.send_replace(true);
    }
    while jobs.join_next().await.is_some() {}
    result
}
async fn query_reply(owner: &Owner, call: &PluginCall) -> RpcBody {
    match owner.query(call).await {
        Ok((data, completeness)) => RpcBody::QueryResult {
            data,
            completeness,
            source: None,
        },
        Err(error) => failure(error),
    }
}
