use crate::context::{Failure, Job, Step};
use rho_plugin_sdk::{BackendConnection, protocol::*};
use std::collections::BTreeMap;
use tokio::io::{AsyncRead, AsyncWrite};

fn error(code: impl Into<String>, message: impl Into<String>) -> RpcBody {
    RpcBody::Error {
        code: code.into(),
        message: message.into(),
        recovery: None,
    }
}
fn failure(failure: Failure) -> RpcBody {
    error(failure.code, failure.message)
}

/// Bounded, read-only reverse-query state machines. No files, database, runtime
/// startup or recovery work is performed by this process.
pub async fn serve<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut connection: BackendConnection<R, W>,
) -> Result<(), String> {
    for id in ["documents.list", "documents.inspect", "documents.read"] {
        if !connection.grants.iter().any(|grant| {
            grant.capability.id.as_str() == id
                && grant.capability.version == 1
                && grant.scopes.contains("documents.read")
        }) {
            return Err(format!(
                "Editor context requires an explicit {id} grant with documents.read"
            ));
        }
    }
    connection.ready().await.map_err(|e| e.to_string())?;
    let mut pending: BTreeMap<RequestId, (RequestId, Job)> = BTreeMap::new();
    let mut serial = 0u64;
    while let Some(frame) = connection
        .reader
        .receive()
        .await
        .map_err(|e| e.to_string())?
    {
        let request = frame.request.clone();
        let outcome = if let Some((original, mut job)) = pending.remove(&request) {
            let result = match frame.body {
                RpcBody::HostResult { result } => job.resume(result).map_err(failure),
                RpcBody::Error { code, message, .. } => Err(error(code, message)),
                _ => return Err("Unexpected correlated draft response".into()),
            };
            (original, Some(job), result)
        } else {
            if matches!(&frame.body, RpcBody::Query(_)) {
                connection
                    .validate_call(&frame)
                    .map_err(|e| e.to_string())?;
            }
            match frame.body {
                RpcBody::Query(call) if pending.len() < 16 => {
                    match Job::start(&connection.instance, &call) {
                        Ok((job, step)) => (request, Some(job), Ok(step)),
                        Err(fault) => (request, None, Err(failure(fault))),
                    }
                }
                RpcBody::Query(_) => (
                    request,
                    None,
                    Err(error(
                        "busy",
                        "Editor context observation capacity reached; retry this read",
                    )),
                ),
                RpcBody::Release if pending.is_empty() => {
                    connection
                        .writer
                        .send(request, RpcBody::Released)
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                }
                RpcBody::Release => (
                    request,
                    None,
                    Err(error("busy", "Editor context reads are still pending")),
                ),
                _ => (
                    request,
                    None,
                    Err(error(
                        "unsupported",
                        "Editor context supports read-only queries",
                    )),
                ),
            }
        };
        let (original, job, result) = outcome;
        let reply = match result {
            Ok(Step::Read {
                capability,
                arguments,
            }) => {
                let reverse = loop {
                    serial = serial
                        .checked_add(1)
                        .ok_or("Editor request counter exhausted")?;
                    let candidate = RequestId::new(format!("editor-context-{serial}"))
                        .map_err(|e| e.to_string())?;
                    if candidate != original
                        && !pending.contains_key(&candidate)
                        && !pending.values().any(|(parent, _)| *parent == candidate)
                    {
                        break candidate;
                    }
                };
                connection
                    .writer
                    .send(
                        reverse.clone(),
                        RpcBody::HostCall {
                            parent_request: original.clone(),
                            capability: CapabilityKey {
                                id: ContributionId::new(capability).unwrap(),
                                version: 1,
                            },
                            arguments,
                        },
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                pending.insert(
                    reverse,
                    (original, job.ok_or("Missing context read owner")?),
                );
                continue;
            }
            Ok(Step::Complete { data, completeness }) => RpcBody::QueryResult {
                data,
                completeness,
                source: None,
            },
            Err(error) => error,
        };
        connection
            .writer
            .send(original, reply)
            .await
            .map_err(|e| e.to_string())?;
    }
    // An ended channel terminates observation only. It never creates a mutation,
    // restart, implicit continuation or successful result for the lost reader.
    Ok(())
}
