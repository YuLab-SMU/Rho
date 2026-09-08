use rho_contract::{HostRequest, MAX_ARGUMENT_BYTES, SessionFrame, SessionReply};
use rho_host::NextHost;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    task::JoinSet,
};

const MAX_FRAME_BYTES: usize = MAX_ARGUMENT_BYTES + 4096;
const MAX_REPLY_BYTES: usize = 8 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 32;

pub async fn serve(
    host: Arc<NextHost>,
    input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> Result<(), String> {
    write_packet(
        &mut output,
        &json!({"type":"ready", "protocol_version":1, "capabilities":host.capabilities()}),
    )
    .await?;
    let mut reader = BufReader::new(input);
    let mut buffer = Vec::new();
    let mut tasks = JoinSet::new();
    let mut in_flight = BTreeSet::new();
    let mut ended = false;
    let mut output_error = None;
    while !ended || !tasks.is_empty() {
        tokio::select! {
            next = tasks.join_next(), if !tasks.is_empty() => {
                let reply: SessionReply = match next {
                    Some(Ok(reply)) => reply,
                    Some(Err(error)) => failure(None, format!("response task failed: {error}")),
                    None => continue,
                };
                if let Some(id) = &reply.id { in_flight.remove(id); }
                emit(&mut output, reply, &mut output_error, &mut ended).await;
            }
            count = read_frame(&mut reader, &mut buffer), if !ended => {
                let count = match count {
                    Ok(count) => count,
                    Err(error) => { output_error = Some(error); ended = true; continue; }
                };
                if count == 0 && buffer.is_empty() { ended = true; continue; }
                if buffer.len() > MAX_FRAME_BYTES {
                    ended = true;
                    emit(&mut output, failure(None, "session frame exceeds its byte bound".into()), &mut output_error, &mut ended).await;
                    continue;
                }
                let frame = serde_json::from_slice::<SessionFrame>(&buffer);
                buffer.clear();
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => {
                        emit(&mut output, failure(None, error.to_string()), &mut output_error, &mut ended).await;
                        continue;
                    }
                };
                if frame.id.is_empty() || frame.id.len() > 160 || frame.id.chars().any(char::is_control) {
                    emit(&mut output, failure(None, "invalid session request id".into()), &mut output_error, &mut ended).await;
                    continue;
                }
                if in_flight.contains(&frame.id) {
                    emit(&mut output, failure(Some(frame.id), "duplicate in-flight session request id".into()), &mut output_error, &mut ended).await;
                    continue;
                }
                if tasks.len() >= MAX_IN_FLIGHT {
                    // A full execution queue must not prevent requesting cancellation.
                    if matches!(&frame.request, HostRequest::RequestCancellation { .. } | HostRequest::RespondInput(_)) || matches!(&frame.request,HostRequest::QuerySnapshot(query) if query.capability.id == "workspace.console_state") {
                        let reply = dispatch(host.clone(), frame).await;
                        emit(&mut output, reply, &mut output_error, &mut ended).await;
                    } else {
                        emit(&mut output, failure(Some(frame.id), "session is at its in-flight request limit".into()), &mut output_error, &mut ended).await;
                    }
                    continue;
                }
                in_flight.insert(frame.id.clone());
                tasks.spawn(dispatch(host.clone(), frame));
            }
        }
    }
    match output_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

// Only consume bytes already copied to the retained frame. select! may resume a
// partial input after delivering a response without losing or duplicating bytes.
async fn read_frame(
    reader: &mut (impl AsyncBufRead + Unpin),
    buffer: &mut Vec<u8>,
) -> Result<usize, String> {
    let mut count = 0;
    loop {
        let available = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if available.is_empty() {
            break;
        }
        let remaining = MAX_FRAME_BYTES + 1 - buffer.len();
        let n = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1)
            .min(remaining);
        buffer.extend_from_slice(&available[..n]);
        reader.consume(n);
        count += n;
        if buffer.last() == Some(&b'\n') || buffer.len() > MAX_FRAME_BYTES {
            break;
        }
    }
    Ok(count)
}

async fn dispatch(host: Arc<NextHost>, frame: SessionFrame) -> SessionReply {
    match host
        .dispatch(&NextHost::local_context(), frame.request)
        .await
    {
        Ok(result) => SessionReply {
            id: Some(frame.id),
            ok: true,
            result: Some(result),
            error: None,
            diagnostic: None,
        },
        Err(error) => SessionReply {
            id: Some(frame.id),
            ok: false,
            result: None,
            error: Some(error.to_string()),
            diagnostic: Some(error.diagnostic()),
        },
    }
}

fn failure(id: Option<String>, error: String) -> SessionReply {
    SessionReply {
        id,
        ok: false,
        result: None,
        error: Some(error),
        diagnostic: None,
    }
}

async fn emit(
    output: &mut (impl AsyncWrite + Unpin),
    reply: SessionReply,
    output_error: &mut Option<String>,
    ended: &mut bool,
) {
    if output_error.is_none()
        && let Err(error) = write_reply(output, reply).await
    {
        *output_error = Some(error);
        *ended = true;
    }
}

async fn write_reply(
    output: &mut (impl AsyncWrite + Unpin),
    reply: SessionReply,
) -> Result<(), String> {
    let value = serde_json::to_value(&reply).map_err(|e| e.to_string())?;
    if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > MAX_REPLY_BYTES {
        return write_packet(output, &json!({"id":reply.id, "ok":false, "error":"reply exceeds the byte bound; use a smaller query page"})).await;
    }
    write_packet(output, &value).await
}
async fn write_packet(output: &mut (impl AsyncWrite + Unpin), value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    output.write_all(&bytes).await.map_err(|e| e.to_string())?;
    output.flush().await.map_err(|e| e.to_string())
}
