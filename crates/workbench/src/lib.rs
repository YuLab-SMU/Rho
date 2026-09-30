#![forbid(unsafe_code)]
mod settings;
mod mcp_sessions;
mod demo_project;
mod plugin_views;

pub use demo_project::materialize_demo_project;

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use rho_contract::{HostRequest, SelectProject, SessionReply, WorkbenchFrame, WorkbenchInfo};
use rho_host::{HostProfile, NextHost};
use rho_mcp::McpEdge;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::transport::streamable_http_server::session::SessionManager;
use tokio::io::AsyncReadExt;
use tokio::sync::{RwLock, Semaphore};
use tokio_util::sync::CancellationToken;
use tower_http::limit::RequestBodyLimitLayer;

const MAX_BODY: usize = 272 * 1024;
const MAX_REPLY: usize = 8 * 1024 * 1024;

struct SelectedHost {
    host: Arc<NextHost>,
    root: PathBuf,
    connections: Arc<rho_mcp::McpConnections>,
}

impl SelectedHost {
    fn new(host: Arc<NextHost>, root: PathBuf) -> Self {
        Self {
            host,
            root,
            connections: Arc::default(),
        }
    }
}

struct Hosting {
    selected: Option<SelectedHost>,
    profile: HostProfile,
}

impl Hosting {
    fn info(&self) -> WorkbenchInfo {
        WorkbenchInfo {
            project_root: self
                .selected
                .as_ref()
                .map(|s| s.root.to_string_lossy().into_owned()),
            runtime: self.profile.runtime_name().into(),
            capabilities: self
                .selected
                .as_ref()
                .map_or_else(Vec::new, |s| s.host.capabilities()),
        }
    }
}

#[derive(Clone)]
struct AppState {
    hosting: Arc<RwLock<Hosting>>,
    authority: String,
    origin: String,
    authorization: String,
    mcp_sessions: Arc<mcp_sessions::HttpMcpSessions>,
    mcp_manager: Arc<LocalSessionManager>,
    calls: Arc<Semaphore>,
    observations: Arc<Semaphore>,
    application: Arc<rho_host::ApplicationStore>,
    dev_assets: Option<PathBuf>,
    nonce: String,
}

fn failure(status: StatusCode, error: impl Into<String>) -> Response {
    (
        status,
        Json(SessionReply {
            diagnostic: None,
            id: None,
            ok: false,
            result: None,
            error: Some(error.into()),
        }),
    )
        .into_response()
}

async fn boundary(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let deleting = request.method() == axum::http::Method::DELETE;
    let plugin_asset = request.method() == axum::http::Method::GET &&
        (request.uri().path().starts_with("/view/plugin/") || request.uri().path().starts_with("/view/plugin-test/"));
    let headers = request.headers();
    if headers.get(header::HOST).and_then(|h| h.to_str().ok()) != Some(&state.authority) {
        return failure(StatusCode::FORBIDDEN, "unexpected local Host");
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1
        || headers
            .get(header::ORIGIN)
            .is_some_and(|h| h.to_str().ok() != Some(&state.origin) && !(plugin_asset && h.to_str().ok() == Some("null")))
    {
        return failure(StatusCode::FORBIDDEN, "foreign Origin");
    }
    let public_asset = matches!(request.uri().path(), "/" | "/app.js" | "/style.css") || plugin_asset;
    let credential = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());
    let mcp_request = request.uri().path() == "/mcp" || request.uri().path().starts_with("/mcp/");
    if !public_asset && credential != Some(state.authorization.as_str()) {
        return failure(StatusCode::UNAUTHORIZED, "local bearer token required");
    }
    let mut session_access = None;
    if mcp_request {
        let hosting = state.hosting.read().await;
        let Some(selected) = &hosting.selected else { return failure(StatusCode::CONFLICT, "Select a project first"); };
        let project = selected.root.to_string_lossy().into_owned();
        if request.headers().get_all("x-rho-test-project").iter().count() > 1 {
            return failure(StatusCode::BAD_REQUEST,"Duplicate test project selection");
        }
        let test_project = match request.headers().get("x-rho-test-project") {
            None => None,
            Some(value) => match value.to_str().ok().and_then(|id|rho_contract::TestProjectId::new(id).ok()) {
                Some(id) => Some(id),
                None => return failure(StatusCode::BAD_REQUEST,"Invalid test project selection"),
            },
        };
        if let Some(id) = &test_project {
            let context = NextHost::local_context();
            if let Err(error) = selected.host.plugin_test_host(&context,id) {
                return failure(StatusCode::CONFLICT,error.to_string());
            }
        }
        let identity = rho_mcp::McpRequestIdentity {
            project, identity: "manual-mcp".into(), test_project,
        };
        if request.headers().get_all("mcp-session-id").iter().count() > 1 {
            return failure(StatusCode::BAD_REQUEST, "Duplicate MCP session identity");
        }
        let session = match request.headers().get("mcp-session-id").map(|value| value.to_str()) {
            Some(Err(_)) => return failure(StatusCode::BAD_REQUEST, "Invalid MCP session identity"),
            value => value.and_then(Result::ok).map(str::to_owned),
        };
        session_access = match state.mcp_sessions.enter(identity.clone(), session) {
            Ok(access) => Some(access),
            Err(error) => return failure(StatusCode::FORBIDDEN, error),
        };
        request.extensions_mut().insert(identity);
    }
    if let Some(access) = &mut session_access {
        // Reclaim transports belonging to a previous selected project. Accepted
        // plugin operations retain their own lifecycle and are not cancelled.
        let mut cleanup = tokio::task::JoinSet::new();
        for id in access.take_expired() {
            let manager = state.mcp_manager.clone();
            cleanup.spawn(async move { let _ = manager.close_session(&id.into()).await; });
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while cleanup.join_next().await.is_some() {}
        }).await;
    }
    let mut response = next.run(request).await;
    if let Some(access) = &mut session_access {
        let session = response.headers().get("mcp-session-id").and_then(|value| value.to_str().ok());
        if let Err(error) = access.finish(session, deleting && response.status().is_success()) {
            return failure(StatusCode::CONFLICT, error);
        }
    }
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    // Isolated HTML views declare their own policy; the shell policy admits them as frames.
    if !headers.contains_key("content-security-policy") {
        headers.insert("content-security-policy", format!("default-src 'none'; script-src 'self'; style-src 'self' 'nonce-{}'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'", state.nonce).parse().unwrap());
    }
    response
}

async fn info(State(state): State<AppState>) -> Response {
    Json(state.hosting.read().await.info()).into_response()
}

async fn agent_connection(State(state): State<AppState>) -> Response {
    let hosting = state.hosting.read().await;
    let observation = hosting.selected.as_ref().map_or_else(
        || rho_mcp::McpConnections::default().snapshot(),
        |selected| selected.connections.snapshot(),
    );
    Json(rho_contract::WorkbenchAgentConnection {
        project_root: hosting
            .selected
            .as_ref()
            .map(|selected| selected.root.to_string_lossy().into_owned()),
        endpoint: format!("{}/mcp", state.origin),
        suggested_server_name: format!(
            "rho_{}",
            state.authority.rsplit(':').next().unwrap_or("local")
        ),
        observed_at_ms: observation.observed_at_ms,
        active_sessions: observation.active_sessions,
        sessions: observation.sessions,
        history_truncated: observation.history_truncated,
    })
    .into_response()
}

fn project_root(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 4096 || !Path::new(path).is_absolute() {
        return Err("select an absolute local project directory".into());
    }
    let root = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("project must be a directory".into());
    }
    if root.to_str().is_none() {
        return Err("project path must be UTF-8 for the browser client".into());
    }
    Ok(root)
}

async fn select_project(
    State(state): State<AppState>,
    Json(request): Json<SelectProject>,
) -> Response {
    let root = match project_root(&request.project_root) {
        Ok(root) => root,
        Err(error) => return failure(StatusCode::BAD_REQUEST, error),
    };
    select_project_root(&state, root).await
}

async fn select_demo_project(State(state): State<AppState>) -> Response {
    let root = match demo_project::materialize_demo_project() {
        Ok(root) => root,
        Err(error) => return failure(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    select_project_root(&state, root).await
}

async fn select_project_root(state: &AppState, root: PathBuf) -> Response {
    // A write guard excludes new UI calls and new MCP sessions throughout teardown/open.
    let Ok(mut hosting) = state.hosting.try_write() else {
        return failure(
            StatusCode::CONFLICT,
            "Host has active requests; project was not changed",
        );
    };
    if let Some(selected) = &hosting.selected {
        if selected.root == root {
            return Json(hosting.info()).into_response();
        }
        if !selected.host.is_idle()
            || Arc::strong_count(&selected.host) != 1
        {
            return failure(
                StatusCode::CONFLICT,
                "Host is busy or an MCP session is attached; finish work and disconnect the session before switching",
            );
        }
    }
    let profile = if hosting.selected.is_some() {
        hosting.profile.for_new_project()
    } else {
        hosting.profile.clone()
    };
    let reserved = match profile.reserve(&root) {
        Ok(reserved) => reserved,
        Err(error) => {
            return failure(
                StatusCode::CONFLICT,
                format!("Project was not changed: {error}"),
            );
        }
    };
    if let Some(old) = hosting.selected.take() {
        old.host.drain().await;
        drop(old);
    }
    hosting.profile = profile;
    match reserved.open_deferred().await {
        Ok(host) => {
            hosting.selected = Some(SelectedHost::new(Arc::new(host), root));
            Json(hosting.info()).into_response()
        }
        Err(error) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Project could not be opened; no replacement profile was selected: {error}"),
        ),
    }
}

async fn dispatch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<WorkbenchFrame>,
) -> Response {
    if request.frame.id.is_empty() || request.frame.id.len() > 160 {
        return failure(StatusCode::BAD_REQUEST, "invalid transport request id");
    }
    let quota = match &request.frame.request {
        HostRequest::Invoke(_) | HostRequest::ApplicationExecute(_) => Some(&state.calls),
        HostRequest::QuerySnapshot(_) => Some(&state.observations),
        _ => None,
    };
    let _permit = if let Some(quota) = quota {
        match quota.try_acquire() {
            Ok(permit) => Some(permit),
            Err(_) => return failure(StatusCode::TOO_MANY_REQUESTS, "too many active calls"),
        }
    } else {
        None
    };
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "select a project first");
    };
    if selected.root.to_str() != Some(&request.project_root) {
        return failure(
            StatusCode::CONFLICT,
            "project changed; refresh before making another request",
        );
    }
    let mut context = NextHost::local_context();
    if let Some(window) = headers
        .get("x-rho-studio-window")
        .and_then(|v| v.to_str().ok())
    {
        if rho_plugin_protocol::WindowId::new(window).is_err() {
            return failure(
                StatusCode::BAD_REQUEST,
                "invalid Studio window transport identity",
            );
        }
        context.connection_id = format!("studio:{window}");
    }
    let result = selected
        .host
        .dispatch_selected(&context, request.frame.test_project.as_ref(), request.frame.request)
        .await;
    let reply = match result {
        Ok(result) => SessionReply {
            id: Some(request.frame.id),
            ok: true,
            result: Some(result),
            error: None,
            diagnostic: None,
        },
        Err(error) => SessionReply {
            id: Some(request.frame.id),
            ok: false,
            result: None,
            error: Some(error.to_string()),
            diagnostic: Some(error.diagnostic()),
        },
    };
    match serde_json::to_vec(&reply) {
        Ok(bytes) if bytes.len() <= MAX_REPLY => {
            ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
        }
        Ok(_) => failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            "reply too large; use bounded queries (accepted operations are not cancelled)",
        ),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn shell(State(state): State<AppState>) -> Html<String> {
    Html(include_str!("../assets/index.html").replace("__RHO_CSP_NONCE__", &state.nonce))
}
async fn asset(state: AppState, name: &str, kind: &str, embedded: &'static str) -> Response {
    let bytes = if let Some(root) = state.dev_assets {
        let path = root.join(name);
        match path.canonicalize() {
            Ok(path) if path.parent() == Some(root.as_path()) => {
                let read = async {
                    let metadata = tokio::fs::metadata(&path).await?;
                    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
                        return Err(std::io::Error::other("invalid development asset"));
                    }
                    let mut bytes = Vec::new();
                    tokio::fs::File::open(path)
                        .await?
                        .take(16 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .await?;
                    Ok::<_, std::io::Error>(bytes)
                }
                .await;
                match read {
                    Ok(bytes) if bytes.len() <= 16 * 1024 * 1024 => bytes,
                    _ => {
                        return failure(
                            StatusCode::NOT_FOUND,
                            "development asset is unavailable or too large",
                        );
                    }
                }
            }
            _ => {
                return failure(
                    StatusCode::NOT_FOUND,
                    "development asset is outside the selected directory",
                );
            }
        }
    } else {
        embedded.as_bytes().to_vec()
    };
    ([(header::CONTENT_TYPE, kind)], bytes).into_response()
}
async fn javascript(State(state): State<AppState>) -> Response {
    asset(
        state,
        "app.js",
        "text/javascript; charset=utf-8",
        include_str!("../assets/app.js"),
    )
    .await
}
async fn stylesheet(State(state): State<AppState>) -> Response {
    asset(
        state,
        "style.css",
        "text/css; charset=utf-8",
        include_str!("../assets/style.css"),
    )
    .await
}

fn router(state: AppState, shutdown: CancellationToken) -> Router {
    let quit_signal = shutdown.clone();
    let hosting = state.hosting.clone();
    let mcp = StreamableHttpService::new(
        move || {
            let hosting = hosting
                .try_read()
                .map_err(|_| std::io::Error::other("project is changing"))?;
            let host = hosting
                .selected
                .as_ref()
                .ok_or_else(|| std::io::Error::other("select a project first"))?;
            McpEdge::local(host.host.clone())
                .map(|edge| edge.observe_connections(&host.connections).http_project(host.root.to_string_lossy().into_owned()))
                .map_err(std::io::Error::other)
        },
        state.mcp_manager.clone(),
        StreamableHttpServerConfig::default()
            .with_allowed_hosts(vec![state.authority.clone()])
            .with_allowed_origins(vec![state.origin.clone()])
            .with_stateful_mode(true)
            .with_cancellation_token(shutdown),
    );
    Router::new()
        .route("/", get(shell))
        .route("/app.js", get(javascript))
        .route("/style.css", get(stylesheet))
        .route("/api/info", get(info))
        .route(
            "/api/quit",
            post(
                move |State(state): State<AppState>, Json(request): Json<SelectProject>| {
                    let quit_signal = quit_signal.clone();
                    async move {
                        let hosting = state.hosting.write().await;
                        let Some(selected) = &hosting.selected else {
                            return failure(StatusCode::CONFLICT, "No project is selected");
                        };
                        if selected.root.as_path() != Path::new(&request.project_root) {
                            return failure(
                                StatusCode::CONFLICT,
                                "Project changed; review the current Workbench before quitting",
                            );
                        }
                        if let Err(error) = selected.host.prepare_workbench_quit().await {
                            return failure(StatusCode::CONFLICT, error.to_string());
                        }
                        quit_signal.cancel();
                        Json(serde_json::json!({"quitting":true})).into_response()
                    }
                },
            ),
        )
        .route("/api/agent-connection", get(agent_connection))
        .route("/view/plugin/{connection}/{token}/{*path}", get(plugin_views::asset))
        .route("/view/plugin-test/{test_project}/{connection}/{token}/{*path}", get(plugin_views::test_asset))
        .route("/api/plugin-view", post(plugin_views::dispatch))
        .route("/api/project", post(select_project))
        .route("/api/project/demo", post(select_demo_project))
        .route("/api/state/read", post(settings::read_state))
        .route("/api/state/write", post(settings::write_state))
        .route(
            "/api/host",
            post(dispatch)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(MAX_BODY))
                .layer(RequestBodyLimitLayer::new(MAX_BODY)),
        )
        .nest_service("/mcp", mcp)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024 + 8192))
        .layer(RequestBodyLimitLayer::new(2 * 1024 * 1024 + 8192))
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .with_state(state)
}

/// Local-only workbench. A URL fragment hands the bearer to the browser without
/// placing it in an HTTP request URL, Referer, static file or application log.
pub async fn serve(
    database: PathBuf,
    project: Option<&Path>,
    port: u16,
    url_file: Option<&Path>,
) -> Result<(), String> {
    serve_with_assets(database, project, port, url_file, None).await
}

pub async fn serve_with_assets(
    database: PathBuf,
    project: Option<&Path>,
    port: u16,
    url_file: Option<&Path>,
    dev_assets: Option<&Path>,
) -> Result<(), String> {
    let profile = HostProfile {
        database, runtime: rho_host::RuntimeConfiguration::Plugins,
        remote: None, host_skills: None,
    };
    let application = Arc::new(rho_host::ApplicationStore::open(
        &profile.database.with_extension("studio.sqlite"),
    )?);
    let dev_assets = dev_assets
        .map(|p| p.canonicalize().map_err(|e| e.to_string()))
        .transpose()?;
    let selected = if let Some(project) = project {
        let root = project_root(&project.to_string_lossy())?;
        let host = profile.open_deferred(&root).await?;
        Some(SelectedHost {
            host: Arc::new(host),
            root,
            connections: Arc::default(),
        })
    } else {
        None
    };
    let hosting = Arc::new(RwLock::new(Hosting {
        selected,
        profile,
    }));
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| e.to_string())?;
    let authority = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let origin = format!("http://{authority}");
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let url = format!("{origin}/?plugin-window#token={token}");
    let state = AppState {
        hosting: hosting.clone(),
        authority,
        origin: origin.clone(),
        authorization: format!("Bearer {token}"),
        mcp_sessions: Arc::default(),
        mcp_manager: Arc::default(),
        calls: Arc::new(Semaphore::new(32)),
        observations: Arc::new(Semaphore::new(16)),
        application,
        dev_assets,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
    };
    let shutdown = CancellationToken::new();
    let app = router(state, shutdown.clone());
    if let Some(path) = url_file {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).map_err(|e| e.to_string())?;
        writeln!(file, "{url}").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        eprintln!(
            "Rho Next workbench listening at {origin}; private launch URL written to {}",
            path.display()
        );
    } else {
        println!("{url}");
    }
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = shutdown.cancelled() => () }
            shutdown.cancel();
        })
        .await;
    if let Some(selected) = &hosting.read().await.selected {
        selected.host.drain().await;
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use rho_host::RuntimeConfiguration;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    pub(super) async fn fixture() -> (tempfile::TempDir, AppState, Router) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let profile = HostProfile {
            host_skills: None,
            database: temp.path().join("next.sqlite"),
            runtime: RuntimeConfiguration::Plugins,
            remote: None,
        };
        let host = Arc::new(profile.open(&root).await.unwrap());
        let application =
            Arc::new(rho_host::ApplicationStore::open(&temp.path().join("studio.sqlite")).unwrap());
        let state = AppState {
            hosting: Arc::new(RwLock::new(Hosting {
                profile,
                selected: Some(SelectedHost::new(host, root)),
            })),
            authority: "127.0.0.1:10001".into(),
            origin: "http://127.0.0.1:10001".into(),
            authorization: "Bearer fixture-only".into(),
            mcp_sessions: Arc::default(),
            mcp_manager: Arc::default(),
            calls: Arc::new(Semaphore::new(32)),
            observations: Arc::new(Semaphore::new(16)),
            application,
            dev_assets: None,
            nonce: "fixture-nonce".into(),
        };
        let app = router(state.clone(), CancellationToken::new());
        (temp, state, app)
    }
    async fn request(app: &Router, uri: &str, body: Option<Value>) -> Response {
        let mut builder = Request::builder()
            .uri(uri)
            .header(header::HOST, "127.0.0.1:10001")
            .header(header::AUTHORIZATION, "Bearer fixture-only");
        if body.is_some() {
            builder = builder
                .method("POST")
                .header(header::CONTENT_TYPE, "application/json");
        }
        app.clone()
            .oneshot(
                builder
                    .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn json_body(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), MAX_REPLY).await.unwrap()).unwrap()
    }
    async fn frame(state: &AppState, method: &str, params: Value) -> Value {
        json!({"project_root":state.hosting.read().await.info().project_root, "frame":{"id":"request","request":{"method":method,"params":params}}})
    }

    #[tokio::test]
    async fn plugin_workspace_uses_generic_ports_and_never_applies_saved_r_configuration() {
        let (temp, state, app) = fixture().await;
        let saved = state.application.read("user", "runtime").unwrap();
        state
            .application
            .write(
                "user",
                &rho_contract::ApplicationState {
                    value: json!({"executable":"/must-not-probe/R","ark":"/must-not-start/ark"}),
                    ..saved
                },
            )
            .unwrap();
        let info = json_body(request(&app, "/api/info", None).await).await;
        assert_eq!(info["runtime"], "plugins");
        assert!(
            !info["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|cap| cap["capability"]["id"] == "workspace.run_r")
        );
        let body = frame(&state, "query_snapshot", json!({"capability":{"id":"plugins.list","version":1},"arguments":{"after":null,"limit":100}})).await;
        let inventory = json_body(request(&app, "/api/host", Some(body)).await).await;
        assert_eq!(inventory["result"]["data"]["total"], 0);
        assert_eq!(request(&app, "/api/r", None).await.status(), StatusCode::NOT_FOUND);
        for path in ["/api/r", "/api/r/probe", "/api/application/bridge"] {
            assert_eq!(request(&app, path, Some(json!({}))).await.status(), StatusCode::NOT_FOUND);
        }
        let other = temp.path().join("other-project");
        std::fs::create_dir(&other).unwrap();
        let switched =
            json_body(request(&app, "/api/project", Some(json!({"project_root":other}))).await)
                .await;
        assert_eq!(switched["runtime"], "plugins");
        assert_eq!(
            switched["project_root"],
            other.canonicalize().unwrap().to_str().unwrap()
        );
        assert!(!temp.path().join("runtime").exists());
        assert!(!temp.path().join("environment").exists());
    }

    #[tokio::test]
    async fn plugin_workspace_can_wait_for_an_explicit_project_selection() {
        let (temp, state, app) = fixture().await;
        let selected = state.hosting.write().await.selected.take().unwrap();
        selected.host.drain().await;
        drop(selected);
        let info = json_body(request(&app, "/api/info", None).await).await;
        assert!(info["project_root"].is_null());
        assert_eq!(info["runtime"], "plugins");
        let opened = json_body(request(&app, "/api/project", Some(json!({"project_root":temp.path().join("project")}))).await).await;
        assert_eq!(opened["runtime"], "plugins");
        assert!(opened["project_root"].is_string());
        assert!(!temp.path().join("runtime").exists());
    }

    #[tokio::test]
    async fn explicit_quit_requires_the_reviewed_project_and_signals_only_after_host_acceptance() {
        let (_temp, state, _) = fixture().await;
        let signal = CancellationToken::new();
        let app = router(state.clone(), signal.clone());
        let wrong = request(
            &app,
            "/api/quit",
            Some(json!({"project_root":"/different-project"})),
        )
        .await;
        assert_eq!(wrong.status(), StatusCode::CONFLICT);
        assert!(!signal.is_cancelled());
        let root = state.hosting.read().await.info().project_root;
        let result = request(&app, "/api/quit", Some(json!({"project_root":root}))).await;
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(json_body(result).await["quitting"], true);
        assert!(signal.is_cancelled());
    }

    #[tokio::test]
    async fn retired_scientific_http_routes_have_no_builtin_fallback() {
        let (_temp, state, app) = fixture().await;
        let host = state.hosting.read().await.selected.as_ref().unwrap().host.clone();
        let before = host.outbox(&NextHost::local_context(), 0, 100).await.unwrap();
        for path in [
            "/api/agents/discover", "/api/agents/setup", "/api/agents/test",
            "/api/agents/tasks/query", "/api/agents/tasks/command", "/api/agents/tasks/asset",
            "/api/agents/handoff/query", "/api/agents/handoff/command",
            "/api/agents/components/query", "/api/agents/components/command",
            "/api/agents/components/credential", "/api/agents/components/context",
            "/api/agents/components/context/search", "/api/agents/components/test",
            "/api/agents/components/asset", "/api/agents/components/asset/upload",
            "/api/annotations/query", "/api/annotations/command", "/api/annotations/capture",
            "/api/html/token",
        ] {
            assert_eq!(request(&app, path, Some(json!({}))).await.status(), StatusCode::NOT_FOUND, "{path}");
        }
        assert_eq!(request(&app, "/view/html/retired-token", None).await.status(), StatusCode::NOT_FOUND);
        // Only the explicit Workbench credential reaches its public MCP edge.
        // Ordinary Agent backends issue credentials on their own private endpoint.
        for method in ["POST", "GET", "DELETE"] {
            let response = app.clone().oneshot(Request::builder().method(method).uri("/mcp")
                .header(header::HOST, "127.0.0.1:10001")
                .header(header::AUTHORIZATION, "Bearer native-fixture-only")
                .body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        assert!(host.is_idle());
        assert_eq!(host.outbox(&NextHost::local_context(), 0, 100).await.unwrap(), before);
    }

    #[tokio::test]
    async fn local_boundary_rejects_foreign_host_origin_and_missing_token() {
        let (_temp, _state, app) = fixture().await;
        for (uri, host, origin, token, expected) in [
            (
                "/api/info",
                "127.0.0.1:10001",
                None,
                None,
                StatusCode::UNAUTHORIZED,
            ),
            (
                "/mcp",
                "127.0.0.1:10001",
                None,
                None,
                StatusCode::UNAUTHORIZED,
            ),
            ("/", "evil.example:10001", None, None, StatusCode::FORBIDDEN),
            (
                "/api/info",
                "127.0.0.1:10001",
                Some("https://evil.example"),
                Some("Bearer fixture-only"),
                StatusCode::FORBIDDEN,
            ),
            (
                "/api/info",
                "127.0.0.1:10001",
                Some("null"),
                Some("Bearer fixture-only"),
                StatusCode::FORBIDDEN,
            ),
        ] {
            let mut req = Request::builder().uri(uri).header(header::HOST, host);
            if let Some(origin) = origin {
                req = req.header(header::ORIGIN, origin);
            }
            if let Some(token) = token {
                req = req.header(header::AUTHORIZATION, token);
            }
            let reply = app
                .clone()
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(reply.status(), expected);
            assert!(!reply.headers().contains_key("access-control-allow-origin"));
        }
        let shell = request(&app, "/", None).await;
        assert_eq!(shell.status(), StatusCode::OK);
        assert_eq!(shell.headers()["cache-control"], "no-store");
        assert!(
            shell.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        let bytes = to_bytes(shell.into_body(), MAX_REPLY).await.unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("fixture-only"));
        assert_eq!(
            request(&app, "/api/project", None).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn queries_are_pure_and_stale_projects_cannot_dispatch() {
        let (_temp, state, app) = fixture().await;
        let before = frame(&state, "subscribe", json!({"after_sequence":0,"limit":100})).await;
        let initial = json_body(request(&app, "/api/host", Some(before.clone())).await).await;
        let query = frame(
            &state,
            "query_snapshot",
            json!({"capability":{"id":"plugins.list","version":1},"arguments":{"after":null,"limit":10}}),
        )
        .await;
        let snapshot = json_body(request(&app, "/api/host", Some(query.clone())).await).await;
        assert_eq!(snapshot["ok"], true);
        assert_eq!(snapshot["result"]["status"], "ready");
        let after = json_body(request(&app, "/api/host", Some(before)).await).await;
        assert_eq!(initial, after);
        let mut stale = query;
        stale["project_root"] = json!("/wrong-project");
        assert_eq!(
            request(&app, "/api/host", Some(stale)).await.status(),
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn invocation_uses_host_idempotency_and_bounded_json() {
        let (_temp, state, app) = fixture().await;
        let input = frame(&state, "invoke", json!({"client_request_id":"http-test", "capability":{"id":"scenarios.checkpoint","version":1},"arguments":{"scenario":"http-fixture","expected_head":null,"name":"HTTP fixture","instances":{},"providers":[],"layout":{"kind":"empty"}},"preconditions":[]})).await;
        let first = json_body(request(&app, "/api/host", Some(input.clone())).await).await;
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(first["result"]["status"], "succeeded");
        let second = json_body(request(&app, "/api/host", Some(input)).await).await;
        assert_eq!(first, second);
        let large = Request::builder()
            .method("POST")
            .uri("/api/host")
            .header(header::HOST, "127.0.0.1:10001")
            .header(header::AUTHORIZATION, "Bearer fixture-only")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(" ".repeat(MAX_BODY + 1)))
            .unwrap();
        assert_eq!(
            app.oneshot(large).await.unwrap().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn mcp_sessions_and_active_edges_fence_project_switching() {
        let (temp, state, app) = fixture().await;
        let other = temp.path().join("other");
        std::fs::create_dir(&other).unwrap();
        let change = json!({"project_root":other});
        let hosting = state.hosting.read().await;
        let edge = McpEdge::local(hosting.selected.as_ref().unwrap().host.clone()).unwrap();
        assert_eq!(
            request(&app, "/api/project", Some(change.clone()))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        drop(hosting);
        assert_eq!(
            request(&app, "/api/project", Some(change.clone()))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        drop(edge);
        let changed = request(&app, "/api/project", Some(change)).await;
        assert_eq!(changed.status(), StatusCode::OK);
        assert_eq!(
            json_body(changed).await["project_root"],
            json!(other.canonicalize().unwrap())
        );
    }

    #[tokio::test]
    async fn occupied_target_does_not_close_the_current_host() {
        let (temp, state, app) = fixture().await;
        let other = temp.path().join("other");
        std::fs::create_dir(&other).unwrap();
        let other_host = NextHost::open_plugin_workspace(temp.path().join("other.sqlite"), &other)
            .await
            .unwrap();
        let current = {
            let hosting = state.hosting.read().await;
            Arc::downgrade(&hosting.selected.as_ref().unwrap().host)
        };
        let before = state.hosting.read().await.info().project_root;
        let rejected = request(&app, "/api/project", Some(json!({"project_root":other}))).await;
        assert_eq!(rejected.status(), StatusCode::CONFLICT);
        assert!(
            current.upgrade().is_some(),
            "target ownership refusal dropped the original runtime"
        );
        assert_eq!(state.hosting.read().await.info().project_root, before);
        other_host.drain().await;
    }
    #[tokio::test]
    async fn application_state_is_scoped_and_uses_compare_and_swap() {
        let (_temp, state, app) = fixture().await;
        let project = state.hosting.read().await.info().project_root;
        let initial = json_body(
            request(
                &app,
                "/api/state/read",
                Some(json!({"project_root":project,"key":"studio"})),
            )
            .await,
        )
        .await;
        let write = json!({"project_root":project,"state":{"key":"studio","version":initial["version"],"value":{"draft":"retained"}}});
        let saved = request(&app, "/api/state/write", Some(write.clone())).await;
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(
            request(&app, "/api/state/write", Some(write))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            request(
                &app,
                "/api/state/read",
                Some(json!({"project_root":"/other","key":"studio"}))
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        let outbox = frame(&state, "subscribe", json!({"after_sequence":0,"limit":100})).await;
        assert_eq!(
            json_body(request(&app, "/api/host", Some(outbox)).await).await["result"],
            json!([])
        );
    }

    #[tokio::test]
    async fn development_assets_are_bounded_and_only_selected_files_are_served() {
        let (temp, mut state, _app) = fixture().await;
        let assets = temp.path().join("assets");
        std::fs::create_dir(&assets).unwrap();
        std::fs::write(assets.join("app.js"), "first").unwrap();
        state.dev_assets = Some(assets.canonicalize().unwrap());
        let app = router(state, CancellationToken::new());
        let response = request(&app, "/app.js", None).await;
        assert_eq!(
            &to_bytes(response.into_body(), MAX_REPLY).await.unwrap()[..],
            b"first"
        );
        std::fs::write(assets.join("app.js"), "second").unwrap();
        assert_eq!(
            &to_bytes(request(&app, "/app.js", None).await.into_body(), MAX_REPLY)
                .await
                .unwrap()[..],
            b"second"
        );
        assert_eq!(
            request(&app, "/secret.txt", None).await.status(),
            StatusCode::NOT_FOUND
        );
        #[cfg(unix)]
        {
            std::fs::remove_file(assets.join("app.js")).unwrap();
            std::fs::write(temp.path().join("outside.js"), "not served").unwrap();
            std::os::unix::fs::symlink(temp.path().join("outside.js"), assets.join("app.js"))
                .unwrap();
            assert_eq!(
                request(&app, "/app.js", None).await.status(),
                StatusCode::NOT_FOUND
            );
        }
    }


}


#[cfg(test)]
mod plugin_test_project_tests;
