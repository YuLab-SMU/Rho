use crate::owner::{Owner, failed};
use rho_plugin_sdk::{BackendConnection, ResourceClient, protocol::*, validate_settlement};
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
pub async fn serve<R, W>(mut connection: BackendConnection<R, W>) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
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
    let mut cancellations: BTreeMap<String, watch::Sender<bool>> = BTreeMap::new();
    let result = loop {
        tokio::select! {
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok((request, operation, plan))) = completed else { break Err("Process task ended without a confirmed result".into()); };
                cancellations.remove(&operation);
                if let Err(error) = writer.send(request, RpcBody::CommitPlan(plan)).await { break Err(error.to_string()); }
            },
            next = incoming.recv() => {
                let frame = match next { Some(Ok(Some(frame))) => frame, Some(Err(error)) => break Err(error), _ => break Ok(()) };
                let operation_message = matches!(&frame.body, RpcBody::Invoke(_));
                let reply = match frame.body {
                    RpcBody::Query(call) | RpcBody::Invoke(call) => {
                        if call.request != frame.request || call.binding.provider != instance.identity || call.binding.project != instance.project
                            || call.principal != instance.principal || operation_message != call.operation_id.is_some() {
                            break Err("Process call differs from its initialized identity or original owner".into());
                        }
                        if operation_message {
                            let operation = call.operation_id.as_ref().unwrap();
                            if owner.contains(operation) { break Err("Original process operation was dispatched twice".into()); }
                            match owner.admit(&call) {
                                Err(message) => Some(RpcBody::CommitPlan(failed(message))),
                                Ok(()) => {
                                    let operation = operation.clone();
                                    let (cancel, cancellation) = watch::channel(false);
                                    cancellations.insert(operation.clone(), cancel);
                                    let owner = owner.clone();
                                    jobs.spawn(async move { let plan = owner.execute(&call, cancellation).await; (call.request, operation, plan) });
                                    None
                                }
                            }
                        } else {
                            Some(match owner.query(&call) {
                                Ok(data) => RpcBody::QueryResult { data, completeness: ObservationCompleteness::Complete, source: None },
                                Err(message) => error("invalid_process_query", message),
                            })
                        }
                    },
                    RpcBody::Cancel { operation_id } => {
                        if let Some(cancel) = cancellations.get(&operation_id) { cancel.send_replace(true); }
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
                        if !jobs.is_empty() || !owner.ready_to_release() {
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
    for cancellation in cancellations.values() {
        cancellation.send_replace(true);
    }
    while jobs.join_next().await.is_some() {}
    result
}
