//! Ordinary public-protocol executable; no Host, journal or edge implementation.
mod owner;
use owner::Owner;
use rho_plugin_sdk::{ResourceClient, accept_stdio, protocol::*, validate_settlement};
use std::{collections::BTreeMap, sync::Arc};
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve());
    // serve has awaited every owner task and native shutdown. Tokio stdin uses
    // an uncancellable blocking read; waiting for that idle read would deadlock
    // with a Host waiting for process exit after Released. Process exit reclaims
    // this dedicated backend's remaining stdin thread, not any scientific work.
    runtime.shutdown_background();
    result
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let mut connection = accept_stdio().await?;
    let owner = Arc::new(Owner::new(
        connection.instance.configuration.clone(),
        connection
            .environment
            .clone()
            .ok_or("Host native environment is unavailable")?,
        connection.instance.identity.clone(),
        ResourceClient::new(
            connection
                .resource_channel
                .clone()
                .ok_or("Host resources are unavailable")?,
        )?,
    )?);
    connection.ready().await?;
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
    let mut cancellations: BTreeMap<String, watch::Sender<bool>> = BTreeMap::new();
    let result: Result<(), String> = loop {
        tokio::select! {
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok((request, operation, reply))) = completed else {
                    break Err("R owner task ended without a result; native outcome is unconfirmed".into());
                };
                if let Some(operation) = operation { cancellations.remove(&operation); }
                if let Err(error) = writer.send(request, reply).await { break Err(error.to_string()); }
            }
            incoming = frames.recv() => {
                let frame = match incoming {
                    Some(Ok(Some(frame))) => frame,
                    Some(Err(error)) => break Err(error),
                    _ => break Ok(()),
                };
                let operation_message = matches!(&frame.body, RpcBody::Invoke(_));
                let reply = match frame.body {
                    RpcBody::Control(call) => {
                        if call.request != frame.request || call.binding.provider != instance.identity
                            || call.binding.project != instance.project || call.principal != instance.principal
                            || call.operation_id.is_some() {
                            break Err("R control identity differs from the initialized instance".into());
                        }
                        Some(match owner.control(&call) {
                            Ok(data) => RpcBody::ControlResult { data },
                            Err(message) => error("r_control", &message),
                        })
                    }
                    RpcBody::Query(call) | RpcBody::Invoke(call) => {
                        // Host admission is authoritative; also fence mismatched calls
                        // before native owner code sees any arguments.
                        if call.request != frame.request || call.binding.provider != instance.identity
                            || call.binding.project != instance.project || call.principal != instance.principal
                            || operation_message != call.operation_id.is_some() {
                            break Err("R call identity differs from the initialized instance".into());
                        }
                        let is_query = call.operation_id.is_none();
                        let valid_kind = match call.binding.capability.id.as_str() {
                            "r.session" | "r.snapshot" | "r.prepare" => is_query,
                            "r.create_session" | "r.execute" => !is_query,
                            _ => false,
                        };
                        if !valid_kind || call.binding.capability.version != 1 {
                            Some(error("unsupported", "unsupported R capability or message kind"))
                        } else if jobs.len() >= 32 {
                            Some(error("busy", "R owner request limit reached"))
                        } else {
                            let operation = call.operation_id.clone();
                            let (cancel, cancellation) = watch::channel(false);
                            if let Some(operation) = &operation {
                                if cancellations.contains_key(operation) { break Err("duplicate active original Operation".into()); }
                                cancellations.insert(operation.clone(), cancel);
                            }
                            let owner = owner.clone();
                            jobs.spawn(async move {
                                let reply = if is_query {
                                    match owner.query(&call).await {
                                        Ok(data) => {
                                            let completeness = match data.get("completeness").and_then(serde_json::Value::as_str) {
                                                Some("partial") => ObservationCompleteness::Partial,
                                                Some("unknown") => ObservationCompleteness::Unavailable,
                                                _ => ObservationCompleteness::Complete,
                                            };
                                            RpcBody::QueryResult { data, completeness, source: None }
                                        },
                                        Err(message) => error("r_observation", &message),
                                    }
                                } else { RpcBody::CommitPlan(owner.invoke(&call, cancellation).await) };
                                (call.request, operation, reply)
                            });
                            None
                        }
                    }
                    RpcBody::Cancel { operation_id } => {
                        if let Some(cancel) = cancellations.get(&operation_id) { cancel.send_replace(true); }
                        // An interrupt request does not prove the evaluation stopped.
                        Some(RpcBody::CancelAcknowledged { operation_id, confirmed: false })
                    }
                    RpcBody::OperationSettled(settlement) => {
                        if let Err(error) = validate_settlement(&instance, &settlement) { break Err(error.to_string()); }
                        if cancellations.contains_key(settlement.operation_id.as_str()) {
                            Some(error("r_settlement", "Native invocation has not returned its result"))
                        } else {
                            // No queue fence is installed yet. This standard
                            // lifecycle acknowledgement also covers operations
                            // cancelled by the Host before native dispatch.
                            Some(RpcBody::SettlementAcknowledged(settlement))
                        }
                    }
                    RpcBody::Release => {
                        if !jobs.is_empty() { Some(error("busy", "Accepted owner calls must finish before release")) }
                        else {
                            match owner.shutdown().await {
                                Ok(()) => {
                                    break writer.send(frame.request, RpcBody::Released).await.map_err(|e| e.to_string());
                                }
                                Err(message) => break Err(message),
                            }
                        }
                    }
                    _ => Some(error("unsupported", "Unexpected Host message")),
                };
                if let Some(reply) = reply {
                    if let Err(error) = writer.send(frame.request, reply).await { break Err(error.to_string()); }
                }
            }
        }
    };
    // EOF and broken pipes preserve original data. They never produce a success
    // or cancellation acknowledgement. Stop only this backend's native process.
    reader_task.abort();
    owner.begin_shutdown();
    for cancel in cancellations.values() {
        cancel.send_replace(true);
    }
    while jobs.join_next().await.is_some() {}
    let stopped = owner.shutdown().await;
    result?;
    stopped?;
    Ok(())
}
fn error(code: &str, message: &str) -> RpcBody {
    RpcBody::Error {
        code: code.into(),
        message: message.into(),
        recovery: None,
    }
}
