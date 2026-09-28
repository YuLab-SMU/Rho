//! A native connection's private MCP transport, without Host credentials or a
//! scientific dispatcher. The task owner admits calls synchronously and retains
//! their work independently of the returned wait. Dropping an HTTP/MCP wait never
//! cancels, replays or settles an already accepted scientific operation.
use crate::{NativeConnectionLease, NativeTaskEndpoint};
use axum::{
    Router,
    body::{Body, Bytes, HttpBody, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResult, Implementation, InitializeRequestParams,
        InitializeResult, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo,
        Tool, ToolAnnotations,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
        session::{SessionManager, local::LocalSessionManager},
    },
};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch},
};
use tokio_util::sync::CancellationToken;

const MAX_REQUEST_BYTES: usize = 272 * 1024;
const MAX_REPLY_BYTES: usize = 256 * 1024;
const MAX_CATALOG_BYTES: usize = 128 * 1024;
const MAX_SESSIONS: usize = 4;
const MAX_REQUESTS: usize = 16;

/// Descriptive tool metadata does not grant authority. `begin` must validate the
/// current original task admission before accepting any actual work.
pub struct NativeMcpTool {
    pub name: String,
    pub description: String,
    pub parameters: Map<String, Value>,
    pub read_only: bool,
}
/// Connection/session/request identity comes from this authenticated transport,
/// never from arguments supplied by the native Agent. Numeric and textual MCP
/// request IDs remain distinct JSON values.
pub struct NativeMcpCall {
    pub connection: String,
    pub session: String,
    pub request: Value,
    pub tool: String,
    pub arguments: Value,
}
#[derive(Clone)]
pub struct NativeMcpReply {
    pub value: Value,
    pub failed: bool,
}
pub type NativeMcpResult = Result<NativeMcpReply, String>;
pub type NativeMcpPending = oneshot::Receiver<NativeMcpResult>;

pub trait NativeMcpPort: Send + Sync {
    /// Admit and retain the original work before returning its observation wait.
    /// The implementation owns correlation, idempotency, scope checks and child
    /// settlement. A dropped receiver MUST NOT cancel that work. Do not revoke
    /// this endpoint synchronously inside `begin` (it shares the admission gate).
    fn begin(&self, call: NativeMcpCall) -> Result<NativeMcpPending, String>;
}

struct Shared {
    connection: String,
    authorization: String,
    authority: String,
    origin: String,
    stopped: CancellationToken,
    admission: Mutex<()>,
    port: Arc<dyn NativeMcpPort>,
    tools: BTreeMap<String, Tool>,
    requests: Arc<Semaphore>,
    calls: Arc<Semaphore>,
    manager: Arc<LocalSessionManager>,
    initialization: tokio::sync::Mutex<()>,
}
pub struct NativeMcpLease {
    shared: Arc<Shared>,
    closed: watch::Receiver<Option<Result<(), String>>>,
}
impl NativeConnectionLease for NativeMcpLease {
    fn revoke(&self) {
        // Once this gate closes, no handler can begin new owner work. Work
        // already accepted through the port remains with its original owner.
        let _gate = self
            .shared
            .admission
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.shared.stopped.cancel();
    }
}
impl Drop for NativeMcpLease {
    fn drop(&mut self) {
        self.revoke();
    }
}
impl NativeMcpLease {
    pub fn is_closed(&self) -> bool {
        matches!(self.closed.borrow().as_ref(), Some(Ok(())))
    }
    /// Confirm transport shutdown. This never claims native process quiet,
    /// scientific cancellation or child-operation settlement.
    pub async fn close(&self) -> Result<(), String> {
        self.revoke();
        let mut closed = self.closed.clone();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(result) = closed.borrow().clone() {
                    return result;
                }
                closed
                    .changed()
                    .await
                    .map_err(|_| "Native MCP shutdown has no confirmation".to_owned())?;
            }
        })
        .await
        .map_err(|_| "Native MCP shutdown is still unconfirmed".to_owned())?
    }
}
pub struct NativeMcpEndpoint {
    pub endpoint: NativeTaskEndpoint,
    pub lease: Arc<NativeMcpLease>,
}

/// Called only for an explicitly admitted new native connection. Every endpoint
/// has its own random bearer, loopback listener, MCP session manager and lifetime.
pub async fn native_mcp_endpoint(
    port: Arc<dyn NativeMcpPort>,
    tools: Vec<NativeMcpTool>,
) -> Result<NativeMcpEndpoint, String> {
    if tools.len() > 128 {
        return Err("Native MCP tool catalog exceeds its limit".into());
    }
    let mut catalog = BTreeMap::new();
    for tool in tools {
        if tool.name.is_empty()
            || tool.name.len() > 128
            || !tool
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
            || tool.description.len() > 4096
            || catalog.contains_key(&tool.name)
        {
            return Err("Invalid or duplicate native MCP tool declaration".into());
        }
        let name = tool.name.clone();
        catalog.insert(
            name,
            Tool::new(tool.name, tool.description, tool.parameters)
                .with_annotations(ToolAnnotations::new().read_only(tool.read_only)),
        );
    }
    if serde_json::to_vec(&catalog)
        .map_err(|_| "Invalid native MCP catalog")?
        .len()
        > MAX_CATALOG_BYTES
    {
        return Err("Native MCP tool catalog exceeds its byte limit".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Native MCP listener is unavailable")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Native MCP listener has no address")?;
    let origin = format!("http://{address}");
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let shared = Arc::new(Shared {
        connection: uuid::Uuid::new_v4().to_string(),
        authorization: format!("Bearer {token}"),
        authority: address.to_string(),
        origin: origin.clone(),
        stopped: CancellationToken::new(),
        admission: Mutex::new(()),
        port,
        tools: catalog,
        requests: Arc::new(Semaphore::new(MAX_REQUESTS)),
        calls: Arc::new(Semaphore::new(MAX_REQUESTS)),
        manager: Arc::new(LocalSessionManager::default()),
        initialization: tokio::sync::Mutex::new(()),
    });
    let factory = shared.clone();
    let service = StreamableHttpService::new(
        move || {
            if factory.stopped.is_cancelled() {
                return Err(std::io::Error::other("Native MCP connection is closed"));
            }
            Ok(Edge {
                shared: factory.clone(),
            })
        },
        shared.manager.clone(),
        StreamableHttpServerConfig::default()
            .with_allowed_hosts(vec![shared.authority.clone()])
            .with_allowed_origins(vec![shared.origin.clone()])
            .with_stateful_mode(true)
            .with_cancellation_token(shared.stopped.clone()),
    );
    let router = Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(shared.clone(), boundary));
    let stop = shared.stopped.clone();
    let (finished, closed) = watch::channel(None);
    let cleanup = shared.clone();
    tokio::spawn(async move {
        // The SDK token closes streams. Explicitly retire its retained session
        // workers as well, including any incomplete initialization resources.
        let cleanup_task = tokio::spawn(async move {
            cleanup.stopped.cancelled().await;
            let _gate = cleanup.initialization.lock().await;
            let ids: Vec<_> = cleanup
                .manager
                .sessions
                .read()
                .await
                .keys()
                .cloned()
                .collect();
            for id in ids {
                cleanup
                    .manager
                    .close_session(&id)
                    .await
                    .map_err(|_| "Native MCP session cleanup is unconfirmed".to_owned())?;
            }
            Ok::<_, String>(())
        });
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(stop.clone().cancelled_owned())
            .await
            .map_err(|_| "Native MCP transport ended without clean shutdown".to_owned());
        stop.cancel();
        let retired = cleanup_task
            .await
            .map_err(|_| "Native MCP session cleanup has no confirmation".to_owned())
            .and_then(|result| result);
        let _ = finished.send(Some(result.and(retired)));
    });
    let lease = Arc::new(NativeMcpLease { shared, closed });
    Ok(NativeMcpEndpoint {
        endpoint: NativeTaskEndpoint {
            url: format!("{origin}/mcp"),
            token,
            lease: lease.clone(),
        },
        lease,
    })
}

// Keep the capacity lease for the complete SSE/body lifetime, not merely until
// headers are returned. Dropping a stream releases only its observation slot.
struct LeasedBody {
    inner: Body,
    _permit: OwnedSemaphorePermit,
}
impl HttpBody for LeasedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        Pin::new(&mut self.inner).poll_frame(context)
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

async fn boundary(State(shared): State<Arc<Shared>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    if shared.stopped.is_cancelled() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1
        || headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            != Some(&shared.authorization)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if headers.get_all(header::HOST).iter().count() != 1
        || headers.get(header::HOST).and_then(|h| h.to_str().ok()) != Some(&shared.authority)
        || headers.get_all(header::ORIGIN).iter().count() > 1
        || headers
            .get(header::ORIGIN)
            .is_some_and(|h| h.to_str().ok() != Some(&shared.origin))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if headers.get_all("mcp-session-id").iter().count() > 1
        || headers.get("mcp-session-id").is_some_and(|h| {
            h.to_str()
                .ok()
                .is_none_or(|s| s.is_empty() || s.len() > 256)
        })
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !matches!(
        *request.method(),
        Method::POST | Method::GET | Method::DELETE
    ) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    // The SDK treats deleting an unknown session as an idempotent success.
    // At this private connection boundary, a foreign session is never accepted.
    if let Some(session) = headers.get("mcp-session-id").and_then(|h| h.to_str().ok())
        && !shared.manager.sessions.read().await.contains_key(session)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(permit) = shared.requests.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let (parts, body) = request.into_parts();
    let bytes =
        match tokio::time::timeout(Duration::from_secs(5), to_bytes(body, MAX_REQUEST_BYTES)).await
        {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        };
    if shared.stopped.is_cancelled() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let initializing =
        parts.method == Method::POST && !parts.headers.contains_key("mcp-session-id");
    // The SDK can allocate a session before rejecting an invalid initialization.
    // Serialize that allocation and reclaim only newly allocated failed sessions.
    let _initializing = if initializing {
        Some(shared.initialization.lock().await)
    } else {
        None
    };
    if shared.stopped.is_cancelled() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let prior = if initializing {
        let sessions = shared.manager.sessions.read().await;
        if sessions.len() >= MAX_SESSIONS {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        Some(
            sessions
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>(),
        )
    } else {
        None
    };
    let mut response = next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await;
    if let Some(prior) = prior {
        let retained = response
            .status()
            .is_success()
            .then(|| {
                response
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|h| h.to_str().ok())
            })
            .flatten();
        let abandoned: Vec<_> = shared
            .manager
            .sessions
            .read()
            .await
            .keys()
            .filter(|id| !prior.contains(*id) && Some(id.as_ref()) != retained)
            .cloned()
            .collect();
        for id in abandoned {
            if shared.manager.close_session(&id).await.is_err() {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
        }
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response.map(|body| {
        Body::new(LeasedBody {
            inner: body,
            _permit: permit,
        })
    })
}

struct Edge {
    shared: Arc<Shared>,
}
impl ServerHandler for Edge {
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        if self.shared.stopped.is_cancelled() {
            return Err(ErrorData::invalid_request(
                "Native MCP connection is closed",
                None,
            ));
        }
        context.peer.set_peer_info(request);
        Ok(self.get_info())
    }
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("rho-agent", env!("CARGO_PKG_VERSION")))
            .with_instructions("Tools use the current task's original admitted scope. Disconnect or cancelling an MCP wait does not cancel accepted scientific work. Inspect original operation receipts after an uncertain reply; never infer success or replay from transport closure.")
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.shared.tools.get(name).cloned()
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        if self.shared.stopped.is_cancelled() {
            return Err(ErrorData::invalid_request(
                "Native MCP connection is closed",
                None,
            ));
        }
        if request.is_some_and(|r| r.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "This bounded catalog has no continuation cursor",
                None,
            ));
        }
        let mut result = ListToolsResult::default();
        result.tools = self.shared.tools.values().cloned().collect();
        Ok(result)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if request.task.is_some() {
            return Err(ErrorData::invalid_params(
                "Native MCP background tasks are unsupported",
                None,
            ));
        }
        let _call =
            self.shared.calls.clone().try_acquire_owned().map_err(|_| {
                ErrorData::invalid_request("Native MCP tool wait limit reached", None)
            })?;
        if !self.shared.tools.contains_key(request.name.as_ref()) {
            return Err(ErrorData::invalid_params("Unknown native Agent tool", None));
        }
        let parts = context
            .extensions
            .get::<axum::http::request::Parts>()
            .ok_or_else(|| {
                ErrorData::invalid_request("Native MCP transport identity is unavailable", None)
            })?;
        let session = parts
            .headers
            .get("mcp-session-id")
            .and_then(|h| h.to_str().ok())
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or_else(|| {
                ErrorData::invalid_request("Native MCP session identity is unavailable", None)
            })?;
        let id = context.id.clone().into_json_value();
        if serde_json::to_vec(&id)
            .map_err(|_| ErrorData::invalid_params("Invalid MCP request identity", None))?
            .len()
            > 256
        {
            return Err(ErrorData::invalid_params(
                "MCP request identity exceeds its limit",
                None,
            ));
        }
        let pending = {
            let _gate = self.shared.admission.lock().map_err(|_| {
                ErrorData::internal_error("Native MCP admission is unavailable", None)
            })?;
            if self.shared.stopped.is_cancelled() {
                return Err(ErrorData::invalid_request(
                    "Native MCP connection is closed",
                    None,
                ));
            }
            self.shared
                .port
                .begin(NativeMcpCall {
                    connection: self.shared.connection.clone(),
                    session: session.into(),
                    request: id,
                    tool: request.name.into_owned(),
                    arguments: Value::Object(request.arguments.unwrap_or_default()),
                })
                .map_err(|e| ErrorData::invalid_params(e, None))?
        };
        // Only this observation wait is owned by MCP. The port retains accepted
        // work and its original parent even if this future is dropped.
        let reply = tokio::select! {
            _ = self.shared.stopped.cancelled() => return Err(ErrorData::internal_error(
                "Native MCP connection closed; original work remains with its owner", None)),
            _ = context.ct.cancelled() => return Err(ErrorData::internal_error(
                "MCP stopped waiting; original work was not cancelled or replayed", None)),
            reply = pending => reply.map_err(|_| ErrorData::internal_error(
                "Original tool outcome is unconfirmed; inspect its retained request", None))?,
        };
        let result = match reply {
            Ok(reply) if reply.failed => CallToolResult::structured_error(reply.value),
            Ok(reply) => CallToolResult::structured(reply.value),
            Err(error) => CallToolResult::structured_error(serde_json::json!({"error":error})),
        };
        if serde_json::to_vec(&result)
            .map_err(|_| ErrorData::internal_error("Tool result could not be encoded", None))?
            .len()
            > MAX_REPLY_BYTES
        {
            return Err(ErrorData::internal_error(
                "Tool result exceeds the transport limit; inspect its retained native receipt",
                None,
            ));
        }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "mcp/tests.rs"]
mod tests;
