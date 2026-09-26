use crate::owner::{Owner, failed};
use crate::reconcile;
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
    if !connection.grants.iter().any(|grant| {
        grant.capability.id.as_str() == "operation.get"
            && grant.capability.version == 1
            && grant.scopes.contains("operation.read")
    }) {
        return Err(
            "Process recovery requires an explicit operation.get grant with operation.read".into(),
        );
    }
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
        .map_err(|error| error.to_string())?,
    )?);
    connection
        .ready()
        .await
        .map_err(|error| error.to_string())?;
    let instance = connection.instance.clone();
    let (sender, mut incoming) = mpsc::channel(32);
    let mut reader = connection.reader;
    let reader_task = tokio::spawn(async move {
        loop {
            let frame = reader.receive().await.map_err(|error| error.to_string());
            let end = !matches!(&frame, Ok(Some(_)));
            if sender.send(frame).await.is_err() || end {
                break;
            }
        }
    });
    let mut writer = connection.writer;
    let mut jobs = JoinSet::new();
    let mut cancellations: BTreeMap<String, (watch::Sender<bool>, bool)> = BTreeMap::new();
    let mut observations: BTreeMap<RequestId, PluginCall> = BTreeMap::new();
    let mut active_requests = BTreeSet::new();
    let mut serial = 0u64;
    let result = loop {
        tokio::select! {
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok((request, operation, plan))) = completed else { break Err("Process task ended without a confirmed result".into()); };
                cancellations.remove(&operation);
                active_requests.remove(&request);
                if let Err(error) = writer.send(request, RpcBody::CommitPlan(plan)).await { break Err(error.to_string()); }
            },
            next = incoming.recv() => {
                let frame = match next { Some(Ok(Some(frame))) => frame, Some(Err(error)) => break Err(error), _ => break Ok(()) };
                if let Some(call) = observations.remove(&frame.request) {
                    active_requests.remove(&call.request);
                    let reply = match frame.body {
                        RpcBody::HostResult { result } => match owner.prepare_reconciliation(&call, result) {
                            Ok(data) => RpcBody::QueryResult { data, completeness: ObservationCompleteness::Complete, source: None },
                            Err(message) => error("invalid_process_source", message),
                        },
                        RpcBody::Error { code, message, .. } => error(&code, message),
                        _ => break Err("Expected the correlated original-operation observation".into()),
                    };
                    if let Err(error) = writer.send(call.request, reply).await { break Err(error.to_string()); }
                    continue;
                }
                let operation_message = matches!(&frame.body, RpcBody::Invoke(_));
                let reply = match frame.body {
                    RpcBody::Query(call) | RpcBody::Invoke(call) => {
                        if call.request != frame.request || call.binding.provider != instance.identity || call.binding.project != instance.project
                            || call.principal != instance.principal || operation_message != call.operation_id.is_some() {
                            break Err("Process call differs from its initialized identity or original owner".into());
                        }
                        if active_requests.contains(&call.request) { break Err("Process request is already in flight".into()); }
                        if operation_message {
                            let operation = call.operation_id.as_ref().unwrap();
                            if owner.contains(operation) { break Err("Original process operation was dispatched twice".into()); }
                            match owner.admit(&call) {
                                Err(message) => Some(RpcBody::CommitPlan(failed(message))),
                                Ok(()) => {
                                    let operation = operation.clone();
                                    let (cancel, cancellation) = watch::channel(false);
                                    cancellations.insert(operation.clone(), (cancel, call.binding.capability.id.as_str() != reconcile::EXECUTE));
                                    active_requests.insert(call.request.clone());
                                    let owner = owner.clone();
                                    jobs.spawn(async move { let plan = owner.execute(&call, cancellation).await; (call.request, operation, plan) });
                                    None
                                }
                            }
                        } else if call.binding.capability.id.as_str() == reconcile::PREPARE {
                            if observations.len() >= 16 { Some(error("busy", "Original-operation observation capacity reached; retry this read")) }
                            else { match owner.reconciliation_request(&call) {
                                Err(message) => Some(error("invalid_process_query", message)),
                                Ok(operation) => {
                                    let reverse = loop {
                                        serial = serial.checked_add(1).ok_or("Process request counter exhausted")?;
                                        let candidate = RequestId::new(format!("process-source-{serial}")).unwrap();
                                        if candidate != call.request && !observations.contains_key(&candidate) && !active_requests.contains(&candidate)
                                            && !observations.values().any(|pending| pending.request == candidate) { break candidate; }
                                    };
                                    if let Err(error) = writer.send(reverse.clone(), RpcBody::HostCall {
                                        parent_request: call.request.clone(), capability: CapabilityKey { id: ContributionId::new("operation.get").unwrap(), version: 1 },
                                        arguments: json!({"operation_id":operation}),
                                    }).await { break Err(error.to_string()); }
                                    active_requests.insert(call.request.clone());
                                    observations.insert(reverse, call);
                                    None
                                }
                            }}
                        } else {
                            Some(match owner.query(&call) {
                                Ok(data) => RpcBody::QueryResult { data, completeness: ObservationCompleteness::Complete, source: None },
                                Err(message) => error("invalid_process_query", message),
                            })
                        }
                    },
                    RpcBody::Cancel { operation_id } => {
                        if let Some((cancel, true)) = cancellations.get(&operation_id) { cancel.send_replace(true); }
                        Some(RpcBody::CancelAcknowledged { operation_id, confirmed: false })
                    },
                    RpcBody::OperationSettled(settlement) => {
                        if let Err(error) = validate_settlement(&instance, &settlement) { break Err(error.to_string()); }
                        Some(if cancellations.contains_key(settlement.operation_id.as_str()) {
                            error("settlement", "Native process has not returned its original result")
                        } else { match owner.settle(&settlement) {
                            Ok(()) => RpcBody::SettlementAcknowledged(settlement),
                            Err(message) => error("settlement", message),
                        } })
                    },
                    RpcBody::Release => {
                        if !jobs.is_empty() || !observations.is_empty() || !owner.ready_to_release() {
                            Some(error("busy", "Original process calls and native settlements must finish before release"))
                        } else { break writer.send(frame.request, RpcBody::Released).await.map_err(|error| error.to_string()); }
                    },
                    _ => Some(error("unsupported", "Unexpected process protocol message")),
                };
                if let Some(reply) = reply {
                    if let Err(error) = writer.send(frame.request, reply).await { break Err(error.to_string()); }
                }
            }
        }
    };
    reader_task.abort();
    // Channel loss requests cleanup of this owner's work; it cannot acknowledge
    // cancellation, commit a result, undo effects or replay the original request.
    for (cancellation, _) in cancellations.values() {
        cancellation.send_replace(true);
    }
    while jobs.join_next().await.is_some() {}
    result
}
