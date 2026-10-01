//! Bounded reverse calls for a backend with one dedicated reader and writer.
use crate::{SdkError, protocol::*};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fmt,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

pub const MAX_PENDING_HOST_CALLS: usize = 32;
pub const MAX_HOST_CALL_ARGUMENT_BYTES: usize = 256 * 1024;

/// This is an observation of the original exchange, never cancellation or rollback.
#[derive(thiserror::Error)]
pub enum HostCallError {
    #[error("Host call ended without its correlated response; the original outcome is unconfirmed")]
    Unconfirmed,
    #[error("Host call rejected ({code}): {message}")]
    Rejected {
        code: String,
        message: String,
        recovery: Option<Value>,
    },
}
impl fmt::Debug for HostCallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unconfirmed => f.write_str("Unconfirmed"),
            Self::Rejected { code, .. } => f
                .debug_struct("Rejected")
                .field("code", code)
                .finish_non_exhaustive(),
        }
    }
}
type Reply = oneshot::Sender<Result<Value, HostCallError>>;
struct Pending {
    reply: Reply,
    dequeued: bool,
}
struct State {
    closed: bool,
    pending: BTreeMap<RequestId, Pending>,
}

/// Clone into owner/model callback ports. The containing server still verifies
/// active parents and sends these requests through its original RpcWriter.
#[derive(Clone)]
pub struct HostCallClient {
    state: Arc<Mutex<State>>,
    outgoing: mpsc::Sender<OutboundHostCall>,
    capacity: usize,
}
/// Exactly one server loop owns this pump. Drop/close fences admission and wakes
/// every waiter as unconfirmed, including calls already removed from the queue.
pub struct HostCallPump {
    state: Arc<Mutex<State>>,
    outgoing: mpsc::Receiver<OutboundHostCall>,
}
/// Contains the caller's original request ID. No new idempotency identity is made
/// when this is dequeued, sent, or observed after an interrupted wait.
pub struct OutboundHostCall {
    pub request: RequestId,
    pub body: RpcBody,
}
pub struct PendingHostCall {
    request: RequestId,
    reply: oneshot::Receiver<Result<Value, HostCallError>>,
}

pub fn host_call_channel(capacity: usize) -> Result<(HostCallClient, HostCallPump), SdkError> {
    if !(1..=MAX_PENDING_HOST_CALLS).contains(&capacity) {
        return Err(SdkError::Invalid("Host call capacity must be 1–32".into()));
    }
    let (sender, receiver) = mpsc::channel(capacity);
    let state = Arc::new(Mutex::new(State {
        closed: false,
        pending: BTreeMap::new(),
    }));
    Ok((
        HostCallClient {
            state: state.clone(),
            outgoing: sender,
            capacity,
        },
        HostCallPump {
            state,
            outgoing: receiver,
        },
    ))
}
impl HostCallClient {
    /// Admit once, without an await between reserving and queuing the request.
    /// The request ID must be chosen and retained by the containing task owner.
    /// A dropped waiter does not retract, resend, or free an unresolved call.
    /// Host remains authoritative for grants, scopes and the active parent.
    pub fn begin(
        &self,
        request: RequestId,
        parent: RequestId,
        capability: CapabilityKey,
        arguments: Value,
    ) -> Result<PendingHostCall, SdkError> {
        if request == parent {
            return Err(SdkError::Invalid(
                "Host call and parent request IDs must differ".into(),
            ));
        }
        if serde_json::to_vec(&arguments)
            .map_err(|error| SdkError::Invalid(error.to_string()))?
            .len()
            > MAX_HOST_CALL_ARGUMENT_BYTES
        {
            return Err(SdkError::Invalid(
                "Host call arguments exceed 256 KiB; use resource references".into(),
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| SdkError::Invalid("Host call channel lock failed".into()))?;
        if state.closed || self.outgoing.is_closed() {
            return Err(SdkError::Invalid("Host call channel is closed".into()));
        }
        if state.pending.contains_key(&request) {
            return Err(SdkError::Invalid(
                "Original Host request is still pending; observe it before retrying".into(),
            ));
        }
        if state.pending.len() >= self.capacity {
            return Err(SdkError::Invalid("Host call capacity reached".into()));
        }
        let (reply, receiver) = oneshot::channel();
        state.pending.insert(
            request.clone(),
            Pending {
                reply,
                dequeued: false,
            },
        );
        let outbound = OutboundHostCall {
            request: request.clone(),
            body: RpcBody::HostCall {
                parent_request: parent,
                capability,
                arguments,
            },
        };
        if self.outgoing.try_send(outbound).is_err() {
            state.pending.remove(&request);
            return Err(SdkError::Invalid("Host call could not be queued".into()));
        }
        Ok(PendingHostCall {
            request,
            reply: receiver,
        })
    }
}
impl PendingHostCall {
    pub fn request(&self) -> &RequestId {
        &self.request
    }
    /// No automatic deadline or retry: the owner chooses the waiting policy and
    /// retains native recovery identities if it stops awaiting this response.
    pub async fn receive(self) -> Result<Value, HostCallError> {
        self.reply.await.unwrap_or(Err(HostCallError::Unconfirmed))
    }
}
impl HostCallPump {
    /// Safe to select alongside the dedicated reader's already-decoded frames.
    pub async fn next(&mut self) -> Option<OutboundHostCall> {
        let outgoing = self.outgoing.recv().await?;
        self.state
            .lock()
            .ok()?
            .pending
            .get_mut(&outgoing.request)?
            .dequeued = true;
        Some(outgoing)
    }
    pub fn contains(&self, request: &RequestId) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.pending.contains_key(request))
    }
    pub fn pending(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.pending.len())
            .unwrap_or(MAX_PENDING_HOST_CALLS)
    }
    /// Only pass frames accepted by the original RpcReader. This pump correlates
    /// replies; it does not validate connection identity or grant authority.
    pub fn respond(&mut self, request: &RequestId, body: RpcBody) -> Result<(), SdkError> {
        let result = match body {
            RpcBody::HostResult { result } => Ok(result),
            RpcBody::Error {
                code,
                message,
                recovery,
            } => Err(HostCallError::Rejected {
                code,
                message,
                recovery,
            }),
            _ => {
                return Err(SdkError::Invalid(
                    "Expected a correlated Host result or error".into(),
                ));
            }
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| SdkError::Invalid("Host call channel lock failed".into()))?;
        let pending = state
            .pending
            .get(request)
            .ok_or_else(|| SdkError::Invalid("Unknown or already answered Host call".into()))?;
        if !pending.dequeued {
            return Err(SdkError::Invalid(
                "Host replied before its request left the queue".into(),
            ));
        }
        let reply = state
            .pending
            .remove(request)
            .ok_or_else(|| SdkError::Invalid("Unknown or already answered Host call".into()))?
            .reply;
        // An owner may have stopped waiting. Receiving a result never resends it
        // or turns the abandoned wait into confirmed scientific cancellation.
        let _ = reply.send(result);
        Ok(())
    }
    pub fn close(&mut self) {
        self.outgoing.close();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.closed = true;
        for (_, pending) in std::mem::take(&mut state.pending) {
            let _ = pending.reply.send(Err(HostCallError::Unconfirmed));
        }
        while self.outgoing.try_recv().is_ok() {}
    }
}
impl Drop for HostCallPump {
    fn drop(&mut self) {
        self.close();
    }
}
