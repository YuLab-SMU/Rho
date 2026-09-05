#![forbid(unsafe_code)]

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use rho_next_contract::{HostRequest, SelectProject, SessionReply, WorkbenchFrame, WorkbenchInfo};
use rho_next_host::{HostProfile, NextHost};
use rho_next_mcp::McpEdge;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use tokio::sync::{RwLock, Semaphore};
use tokio_util::sync::CancellationToken;
use tower_http::limit::RequestBodyLimitLayer;

const MAX_BODY: usize = 272 * 1024;
const MAX_REPLY: usize = 8 * 1024 * 1024;

struct SelectedHost {
    host: Arc<NextHost>,
    root: PathBuf,
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
    calls: Arc<Semaphore>,
}

fn failure(status: StatusCode, error: impl Into<String>) -> Response {
    (
        status,
        Json(SessionReply {
            id: None,
            ok: false,
            result: None,
            error: Some(error.into()),
        }),
    )
        .into_response()
}

async fn boundary(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    if headers.get(header::HOST).and_then(|h| h.to_str().ok()) != Some(&state.authority) {
        return failure(StatusCode::FORBIDDEN, "unexpected local Host");
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1
        || headers
            .get(header::ORIGIN)
            .is_some_and(|h| h.to_str().ok() != Some(&state.origin))
    {
        return failure(StatusCode::FORBIDDEN, "foreign Origin");
    }
    let public_asset = matches!(request.uri().path(), "/" | "/app.js" | "/style.css");
    if !public_asset
        && headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            != Some(&state.authorization)
    {
        return failure(StatusCode::UNAUTHORIZED, "local bearer token required");
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'".parse().unwrap());
    response
}

async fn info(State(state): State<AppState>) -> Response {
    Json(state.hosting.read().await.info()).into_response()
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
        if !selected.host.is_idle() || Arc::strong_count(&selected.host) != 1 {
            return failure(
                StatusCode::CONFLICT,
                "Host is busy or an MCP session is attached; finish work and disconnect the session before switching",
            );
        }
    }
    if let Some(old) = hosting.selected.take() {
        old.host.drain().await;
        drop(old);
        hosting.profile = hosting.profile.for_new_project();
    }
    match hosting.profile.open(&root).await {
        Ok(host) => {
            hosting.selected = Some(SelectedHost {
                host: Arc::new(host),
                root,
            });
            Json(hosting.info()).into_response()
        }
        Err(error) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "No project is open. The previous session, if any, has ended; its memory is not restored. {error}"
            ),
        ),
    }
}

async fn dispatch(State(state): State<AppState>, Json(request): Json<WorkbenchFrame>) -> Response {
    if request.frame.id.is_empty() || request.frame.id.len() > 160 {
        return failure(StatusCode::BAD_REQUEST, "invalid transport request id");
    }
    let _permit = if matches!(
        request.frame.request,
        HostRequest::Invoke(_) | HostRequest::QuerySnapshot(_)
    ) {
        match state.calls.try_acquire() {
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
    let result = selected
        .host
        .dispatch(&NextHost::local_context(), request.frame.request)
        .await;
    let reply = match result {
        Ok(result) => SessionReply {
            id: Some(request.frame.id),
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => SessionReply {
            id: Some(request.frame.id),
            ok: false,
            result: None,
            error: Some(error.to_string()),
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

fn router(state: AppState, shutdown: CancellationToken) -> Router {
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
            McpEdge::local(host.host.clone()).map_err(std::io::Error::other)
        },
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_allowed_hosts(vec![state.authority.clone()])
            .with_allowed_origins(vec![state.origin.clone()])
            .with_stateful_mode(true)
            .with_cancellation_token(shutdown),
    );
    Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("../assets/index.html")) }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../assets/app.js"),
                )
            }),
        )
        .route(
            "/style.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../assets/style.css"),
                )
            }),
        )
        .route("/api/info", get(info))
        .route("/api/project", post(select_project))
        .route("/api/host", post(dispatch))
        .nest_service("/mcp", mcp)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(RequestBodyLimitLayer::new(MAX_BODY))
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .with_state(state)
}

/// Local-only workbench. A URL fragment hands the bearer to the browser without
/// placing it in an HTTP request URL, Referer, static file or application log.
pub async fn serve(
    profile: HostProfile,
    project: Option<&Path>,
    port: u16,
    url_file: Option<&Path>,
) -> Result<(), String> {
    let selected = if let Some(project) = project {
        let root = project_root(&project.to_string_lossy())?;
        Some(SelectedHost {
            host: Arc::new(profile.open(&root).await?),
            root,
        })
    } else {
        None
    };
    let hosting = Arc::new(RwLock::new(Hosting { selected, profile }));
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
    let url = format!("{origin}/#token={token}");
    let state = AppState {
        hosting: hosting.clone(),
        authority,
        origin: origin.clone(),
        authorization: format!("Bearer {token}"),
        calls: Arc::new(Semaphore::new(32)),
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
            let _ = tokio::signal::ctrl_c().await;
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
    use rho_next_host::RuntimeConfiguration;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    async fn fixture() -> (tempfile::TempDir, AppState, Router) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let profile = HostProfile {
            database: temp.path().join("next.sqlite"),
            runtime: RuntimeConfiguration::Project,
            remote: None,
        };
        let host = Arc::new(profile.open(&root).await.unwrap());
        let state = AppState {
            hosting: Arc::new(RwLock::new(Hosting {
                profile,
                selected: Some(SelectedHost { host, root }),
            })),
            authority: "127.0.0.1:10001".into(),
            origin: "http://127.0.0.1:10001".into(),
            authorization: "Bearer fixture-only".into(),
            calls: Arc::new(Semaphore::new(32)),
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
            json!({"capability":{"id":"project.snapshot","version":1},"arguments":{}}),
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

    #[cfg(unix)]
    #[tokio::test]
    async fn invocation_uses_host_idempotency_and_bounded_json() {
        let (_temp, state, app) = fixture().await;
        let input = frame(&state, "invoke", json!({"client_request_id":"http-test", "capability":{"id":"process.run_local","version":1},"arguments":{"program":"/usr/bin/printf","args":["42"]},"preconditions":[]})).await;
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
}
