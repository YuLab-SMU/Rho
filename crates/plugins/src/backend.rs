use crate::{PluginError, runtime::*};
use rho_plugin_protocol::*;
use rho_plugin_sdk::{RpcReader, RpcWriter};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

type Response = oneshot::Sender<Result<RpcBody, String>>;
enum CommandMessage {
    Call {
        call: PluginCall,
        kind: CapabilityKind,
        response: Response,
    },
    Cancel {
        operation: String,
        capability: CapabilityKey,
        response: Response,
    },
    Settle {
        settlement: OperationSettlement,
        response: Response,
    },
    Release {
        response: Response,
    },
}

#[derive(Clone)]
pub(crate) struct ProcessClient {
    sender: mpsc::Sender<CommandMessage>,
}
impl ProcessClient {
    pub async fn settle(&self, settlement: OperationSettlement) -> Result<(), PluginError> {
        let (response, receiver) = oneshot::channel();
        self.sender.send(CommandMessage::Settle { settlement: settlement.clone(), response })
            .await.map_err(|_| PluginError::Unavailable("original backend settlement is unconfirmed".into()))?;
        match receive(receiver).await? {
            RpcBody::SettlementAcknowledged(acknowledged) if acknowledged == settlement => Ok(()),
            _ => Err(PluginError::Invalid("native settlement was not acknowledged".into())),
        }
    }
    pub async fn call(&self, call: PluginCall, kind: CapabilityKind) -> Result<RpcBody, PluginError> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CommandMessage::Call {
                call,
                kind,
                response,
            })
            .await
            .map_err(|_| {
                PluginError::Unavailable(
                    "backend is disconnected; inspect the original operation before retrying"
                        .into(),
                )
            })?;
        receive(receiver).await
    }
    pub async fn cancel(
        &self,
        operation: &str,
        capability: &CapabilityKey,
    ) -> Result<bool, PluginError> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CommandMessage::Cancel {
                operation: operation.into(),
                capability: capability.clone(),
                response,
            })
            .await
            .map_err(|_| {
                PluginError::Unavailable(
                    "backend is disconnected; cancellation is unconfirmed".into(),
                )
            })?;
        match receive(receiver).await? {
            RpcBody::CancelAcknowledged { confirmed, .. } => Ok(confirmed),
            _ => Err(PluginError::Invalid("invalid cancellation response".into())),
        }
    }
    pub async fn release(&self) -> Result<(), PluginError> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CommandMessage::Release { response })
            .await
            .map_err(|_| {
                PluginError::Unavailable("backend is disconnected; cleanup is unconfirmed".into())
            })?;
        match receive(receiver).await? {
            RpcBody::Released => Ok(()),
            _ => Err(PluginError::Invalid("invalid release response".into())),
        }
    }
}
async fn receive(
    receiver: oneshot::Receiver<Result<RpcBody, String>>,
) -> Result<RpcBody, PluginError> {
    receiver
        .await
        .map_err(|_| {
            PluginError::Unavailable(
                "backend response was lost; execution may have occurred".into(),
            )
        })?
        .map_err(PluginError::Unavailable)
}

struct TaskGuard<T>(JoinHandle<T>);
impl<T> Drop for TaskGuard<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) async fn start(
    mut prepared: PreparedInstance,
    state: SharedBackendState,
    services: Arc<dyn PluginHostServices>,
    policy: BackendPolicy,
) -> Result<ProcessClient, PluginError> {
    let identity = prepared.record.identity.clone();
    #[cfg(unix)]
    let data_channel = services.resources().map(crate::resource_channel::DataChannel::start).transpose()?;
    #[cfg(unix)]
    let resource_channel = data_channel.as_ref().map(|c| c.endpoint.clone());
    #[cfg(not(unix))]
    let resource_channel = None;
    let mut command = Command::new(prepared.executable.as_ref().ok_or_else(|| PluginError::Invalid("package has no backend".into()))?);
    command
        .args(&prepared.manifest.backend.as_ref().unwrap().arguments)
        .current_dir(prepared.directory.path())
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Do not inherit launch tokens, API keys or other generic Host credentials.
    // Trusted native code can still access local files; this is not an OS sandbox.
    for name in ["PATH", "LANG", "LC_ALL", "LC_CTYPE"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn()?;
    prepared.retain_after_drop = true;
    state.lock().unwrap().pid = child.id();
    let connection = ConnectionId::new(format!("connection-{}", Uuid::new_v4().simple()))?;
    let mut writer = RpcWriter::new(
        child.stdin.take().unwrap(),
        identity.instance.clone(),
        connection.clone(),
    );
    let mut reader = RpcReader::new(
        child.stdout.take().unwrap(),
        identity.instance.clone(),
        connection,
    );
    let (frames_tx, mut frames_rx) = mpsc::channel(32);
    let reader_task = TaskGuard(tokio::spawn(async move {
        loop {
            let frame = reader.receive().await.map_err(|e| e.to_string());
            let terminal = !matches!(&frame, Ok(Some(_)));
            if frames_tx.send(frame).await.is_err() || terminal {
                break;
            }
        }
    }));
    let mut stderr = child.stderr.take().unwrap();
    let log_state = state.clone();
    let log_task = TaskGuard(tokio::spawn(async move {
        let mut chunk = [0; 4096];
        while let Ok(size) = stderr.read(&mut chunk).await {
            if size == 0 {
                break;
            }
            let mut state = log_state.lock().unwrap();
            state.log.extend_from_slice(&chunk[..size]);
            let excess = state.log.len().saturating_sub(MAX_BACKEND_LOG_BYTES);
            state.log.drain(..excess);
        }
    }));
    let initialize = RequestId::new("host-initialize")?;
    let handshake = timeout(policy.initialize_timeout, async {
        writer
            .send(
                initialize.clone(),
                RpcBody::Initialize {
                    instance: prepared.record.clone(),
                    grants: prepared.grants.clone(),
                    environment: prepared.environment.clone(),
                    resource_channel,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        match frames_rx.recv().await {
            Some(Ok(Some(RpcFrame {
                request,
                body: RpcBody::Ready { revision, artifact },
                ..
            }))) if request == initialize
                && revision == identity.revision
                && artifact == identity.artifact =>
            {
                Ok(())
            }
            Some(Err(error)) => Err(error),
            _ => Err("backend did not confirm the exact revision and artifact".into()),
        }
    })
    .await
    .unwrap_or_else(|_| Err("backend initialization timed out".into()));
    if let Err(error) = handshake {
        let killed = child.kill().await;
        let mut record = state.lock().unwrap();
        record.record.state = if killed.is_ok() {
            InstanceState::Failed
        } else {
            InstanceState::CleanupFailed
        };
        record.record.diagnostic = Some(format!("{error}; initialization was not published"));
        if killed.is_ok() {
            record.pid = None;
        }
        drop(record);
        prepared.persist_state(&state);
        return Err(PluginError::Unavailable(error));
    }
    let (sender, receiver) = mpsc::channel(MAX_PENDING_PLUGIN_CALLS);
    tokio::spawn(run(
        prepared,
        child,
        writer,
        frames_rx,
        receiver,
        state,
        services,
        policy,
        reader_task,
        log_task,
        #[cfg(unix)]
        data_channel,
    ));
    Ok(ProcessClient { sender })
}

enum PendingKind {
    Call { call: PluginCall, kind: CapabilityKind },
    Cancel { operation: String },
    Settlement(OperationSettlement),
}
struct Pending {
    kind: PendingKind,
    responses: Vec<Response>,
}
impl Pending {
    fn respond(self, result: Result<RpcBody, String>) {
        for response in self.responses { let _ = response.send(result.clone()); }
    }
}
type IncomingFrames = mpsc::Receiver<Result<Option<RpcFrame>, String>>;

#[allow(clippy::too_many_arguments)]
async fn run(
    mut prepared: PreparedInstance,
    mut child: Child,
    mut writer: RpcWriter<ChildStdin>,
    mut frames: IncomingFrames,
    mut commands: mpsc::Receiver<CommandMessage>,
    state: SharedBackendState,
    services: Arc<dyn PluginHostServices>,
    policy: BackendPolicy,
    _reader_task: TaskGuard<()>,
    _log_task: TaskGuard<()>,
    #[cfg(unix)] data_channel: Option<crate::resource_channel::DataChannel>,
) {
    let mut pending: BTreeMap<RequestId, Pending> = BTreeMap::new();
    // Reconciliation resends the same pending identity. Exact late duplicate
    // acknowledgements are harmless within this bounded transport history.
    let mut settled: VecDeque<(RequestId, OperationSettlement)> = VecDeque::new();
    let mut reverse = BTreeSet::new();
    let mut counter = 0_u64;
    let (host_results_tx, mut host_results_rx) = mpsc::channel::<(RequestId, RpcBody)>(32);
    let failure = loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break "Host released its process handle without confirming cleanup".into(); };
                counter += 1;
                let request = RequestId::new(format!("host-{counter}")).unwrap();
                let (body, request_pending) = match command {
                    CommandMessage::Call { mut call, kind, response } => {
                        if pending.len() >= MAX_PENDING_PLUGIN_CALLS {
                            let _ = response.send(Err("backend pending-call quota reached before dispatch".into())); continue;
                        }
                        call.request = request.clone();
                        #[cfg(unix)]
                        if kind != CapabilityKind::Control { if let Some(channel) = &data_channel { channel.session.insert(&call); } }
                        let body = match kind { CapabilityKind::Query => RpcBody::Query(call.clone()), CapabilityKind::Control => RpcBody::Control(call.clone()), _ => RpcBody::Invoke(call.clone()) };
                        (body, Pending { kind: PendingKind::Call { call, kind }, responses: vec![response] })
                    }
                    CommandMessage::Cancel { operation, capability, response } => {
                        if !pending.values().any(|p| matches!(&p.kind, PendingKind::Call {call, ..}
                            if call.operation_id.as_deref() == Some(operation.as_str()) && call.binding.capability == capability)) {
                            let _ = response.send(Err("no matching active operation; cancellation is unconfirmed".into())); continue;
                        }
                        if pending.len() >= MAX_PENDING_PLUGIN_CALLS {
                            let _ = response.send(Err("cancellation queue is full; cancellation is unconfirmed".into())); continue;
                        }
                        (RpcBody::Cancel { operation_id: operation.clone() }, Pending { kind: PendingKind::Cancel { operation }, responses: vec![response] })
                    }
                    CommandMessage::Settle { settlement, response } => {
                        if let Some((original, retained)) = pending.iter_mut().find(|(_, p)| matches!(&p.kind,
                            PendingKind::Settlement(old) if old.operation_id == settlement.operation_id)) {
                            if !matches!(&retained.kind, PendingKind::Settlement(old) if old == &settlement) {
                                let _ = response.send(Err("original settlement identity changed".into())); continue;
                            }
                            retained.responses.retain(|response| !response.is_closed());
                            if retained.responses.len() >= 32 {
                                let _ = response.send(Err("settlement reconciliation limit reached".into())); continue;
                            }
                            retained.responses.push(response);
                            if let Err(error) = transmit(&mut writer, original.clone(), RpcBody::OperationSettled(settlement), &policy).await { break error; }
                            continue;
                        }
                        if pending.len() >= MAX_PENDING_PLUGIN_CALLS {
                            let _ = response.send(Err("settlement queue is full; original reference retained".into())); continue;
                        }
                        (RpcBody::OperationSettled(settlement.clone()), Pending { kind: PendingKind::Settlement(settlement), responses: vec![response] })
                    }
                    CommandMessage::Release { response } => {
                        if !pending.is_empty() || !reverse.is_empty() {
                            let _ = response.send(Err("backend still has active calls".into())); continue;
                        }
                        #[cfg(unix)]
                        if data_channel.as_ref().is_some_and(|channel| !channel.session.close_if_idle()) {
                            let _ = response.send(Err("backend still has active resource transfers".into())); continue;
                        }
                        let released = release(&mut child, &mut writer, &mut frames, request, &policy).await;
                        let released = released.and_then(|()| prepared.release_reference().map_err(|e| e.to_string()));
                        {
                            let mut state = state.lock().unwrap();
                            state.record.state = if released.is_ok() { InstanceState::Released } else { InstanceState::CleanupFailed };
                            state.record.diagnostic = released.as_ref().err().cloned();
                            state.pid = None;
                        }
                        prepared.persist_state(&state);
                        let _ = response.send(released.map(|()| RpcBody::Released));
                        return;
                    }
                };
                pending.insert(request.clone(), request_pending);
                state.lock().unwrap().pending = pending.len();
                if let Err(error) = transmit(&mut writer, request, body, &policy).await { break error; }
            }
            incoming = frames.recv() => {
                let frame = match incoming {
                    Some(Ok(Some(frame))) => frame,
                    Some(Err(error)) => break error,
                    _ => break "backend disconnected; outstanding execution and cancellation are unconfirmed".into(),
                };
                if let RpcBody::HostCall { parent_request, capability, arguments } = frame.body {
                    if reverse.len() >= 32 || reverse.contains(&frame.request) || pending.contains_key(&frame.request) {
                        break "invalid or excessive delegated Host request".into();
                    }
                    let grant = prepared.grants.iter().find(|g| g.capability == capability);
                    let parent = pending.get(&parent_request).and_then(|p| match &p.kind {
                        PendingKind::Call {call, kind} => Some((call, !matches!(kind, CapabilityKind::Operation | CapabilityKind::Runtime))), _ => None });
                    let delegated = match (grant, parent) {
                        (Some(grant), Some((parent, query))) if grant.scopes.is_subset(&parent.scopes) => {
                            let mut parent = parent.clone();
                            // The reverse call receives only the grant's scopes,
                            // never all capabilities of the original caller.
                            parent.scopes = grant.scopes.clone();
                            Some(DelegatedPluginCall { request: frame.request.clone(), provider: prepared.record.identity.clone(), parent,
                                grant: grant.clone(), query_only: query, arguments })
                        }
                        _ => None,
                    };
                    if let Some(delegated) = delegated {
                        reverse.insert(frame.request.clone());
                        let services = services.clone(); let results = host_results_tx.clone();
                        // Once the Host service accepts work it owns completion.
                        // A plugin disconnect must not abort or replay that work.
                        tokio::spawn(async move {
                            let result = services.call(delegated).await;
                            let body = match result { Ok(result) => RpcBody::HostResult { result },
                                Err(message) => RpcBody::Error { code: "host_call_failed".into(), message, recovery: None } };
                            let _ = results.send((frame.request, body)).await;
                        });
                    } else if let Err(error) = transmit(&mut writer, frame.request, RpcBody::Error {
                        code: "access_denied".into(), message: "reverse call has no active parent or declared grant in scope".into(), recovery: None }, &policy).await { break error; }
                    continue;
                }
                #[cfg(unix)]
                if let Some(channel) = &data_channel { channel.session.remove(&frame.request); }
                let Some(expected) = pending.remove(&frame.request) else {
                    if settled.iter().any(|(request, settlement)| request == &frame.request && frame.body == RpcBody::SettlementAcknowledged(settlement.clone())) { continue; }
                    break "unsolicited or repeated backend response".into();
                };
                state.lock().unwrap().pending = pending.len();
                let valid = match (&expected.kind, &frame.body) {
                    (PendingKind::Call {kind: CapabilityKind::Query, ..}, RpcBody::QueryResult {..} | RpcBody::Error {..}) => true,
                    (PendingKind::Call {kind: CapabilityKind::Control, ..}, RpcBody::ControlResult {..} | RpcBody::Error {..}) => true,
                    (PendingKind::Call {kind: CapabilityKind::Operation | CapabilityKind::Runtime, ..}, RpcBody::CommitPlan(_) | RpcBody::Error {..}) => true,
                    (PendingKind::Cancel {operation}, RpcBody::CancelAcknowledged {operation_id, ..}) => operation == operation_id,
                    (PendingKind::Settlement(settlement), RpcBody::SettlementAcknowledged(acknowledged)) => settlement == acknowledged,
                    (PendingKind::Settlement(_), RpcBody::Error {..}) => true,
                    _ => false,
                };
                if !valid {
                    expected.respond(Err("backend response did not match its pending request".into()));
                    break "backend response kind or operation identity mismatch".into();
                }
                if let (PendingKind::Settlement(settlement), RpcBody::SettlementAcknowledged(_)) = (&expected.kind, &frame.body) {
                    // The native acknowledgement is scheduling cleanup, not
                    // scientific truth. Only the bridge can issue this message
                    // after the original journal has a terminal record.
                    let released = prepared.repository.lock().unwrap().release_reference("operation",
                        &format!("{}:{}", settlement.binding.provider.instance, settlement.operation_id),
                        &settlement.binding.provider.revision).map_err(|e| e.to_string());
                    settled.push_back((frame.request, settlement.clone()));
                    if settled.len() > MAX_PENDING_PLUGIN_CALLS { settled.pop_front(); }
                    if let Err(error) = released { expected.respond(Err(error)); continue; }
                }
                expected.respond(Ok(frame.body));
            }
            completed = host_results_rx.recv(), if !reverse.is_empty() => {
                if let Some((request, body)) = completed {
                    reverse.remove(&request);
                    if let Err(error) = transmit(&mut writer, request, body, &policy).await { break error; }
                }
            }
            exited = child.wait() => {
                break format!("backend process exited ({exited:?}); outstanding execution and cancellation are unconfirmed");
            }
        }
    };
    {
        let mut state = state.lock().unwrap();
        state.record.state = InstanceState::Disconnected;
        state.record.diagnostic = Some(failure.clone());
        state.pending = 0;
        // This PID is historical unless try_wait proves it is still running.
        if child.try_wait().ok().flatten().is_some() {
            state.pid = None;
        }
    }
    prepared.persist_state(&state);
    for (_, expected) in pending {
        expected.respond(Err(failure.clone()));
    }
    // Losing framing fences the instance. Reap this managed direct child, but do
    // not label its scientific work cancelled or remove the retained revision.
    let _ = child.kill().await;
    state.lock().unwrap().pid = None;
}

async fn transmit(
    writer: &mut RpcWriter<ChildStdin>,
    request: RequestId,
    body: RpcBody,
    policy: &BackendPolicy,
) -> Result<(), String> {
    timeout(policy.write_timeout, writer.send(request, body))
        .await
        .map_err(|_| "backend write timed out; dispatch may be partial".to_string())?
        .map_err(|e| e.to_string())
}

async fn release(
    child: &mut Child,
    writer: &mut RpcWriter<ChildStdin>,
    frames: &mut IncomingFrames,
    request: RequestId,
    policy: &BackendPolicy,
) -> Result<(), String> {
    let result = timeout(policy.release_timeout, async {
        transmit(writer, request.clone(), RpcBody::Release, policy).await?;
        match frames.recv().await {
            Some(Ok(Some(RpcFrame {
                request: reply,
                body: RpcBody::Released,
                ..
            }))) if reply == request => (),
            _ => return Err("backend did not acknowledge resource release".into()),
        }
        let exit = child.wait().await.map_err(|e| e.to_string())?;
        if !exit.success() {
            return Err(format!(
                "backend acknowledged release but exited with {exit}"
            ));
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err("backend cleanup timed out".into()));
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}
