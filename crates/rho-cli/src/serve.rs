use anyhow::{Context, Result};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};

use rho_protocol::workbench::{
    WORKBENCH_PROTOCOL_VERSION, WorkbenchError, WorkbenchErrorBody, WorkbenchErrorCode,
    WorkbenchPageInfo, WorkbenchSuccess,
};
use rho_store::Store;

/// Parse a minimal HTTP/1.1 GET request.
fn parse_request(stream: &mut TcpStream) -> Option<(String, String, HashMap<String, String>)> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 || parts[0] != "GET" {
        return None;
    }

    let path = parts[1].to_string();

    // Parse headers
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let line = line.trim().to_string();
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }

    Some((path, String::new(), headers))
}

fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let _ = writeln!(stream, "HTTP/1.1 {} {}", status, status_text(status));
    let _ = writeln!(stream, "Content-Type: {}", content_type);
    let _ = writeln!(stream, "Content-Length: {}", body.len());
    let _ = writeln!(stream, "Access-Control-Allow-Origin: *");
    let _ = writeln!(stream);
    let _ = write!(stream, "{}", body);
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

fn json_error(code: WorkbenchErrorCode, message: &str) -> String {
    let err = WorkbenchError {
        ok: false,
        workbench_protocol_version: WORKBENCH_PROTOCOL_VERSION.to_string(),
        request_id: None,
        project_id: None,
        error: WorkbenchErrorBody {
            code,
            message: message.to_string(),
            retryable: false,
            details: serde_json::Value::Null,
        },
    };
    serde_json::to_string(&err).unwrap()
}

fn json_success<T: serde::Serialize>(project_id: &str, data: &T) -> String {
    let resp = WorkbenchSuccess::new(project_id, data);
    serde_json::to_string(&resp).unwrap()
}

fn json_success_page<T: serde::Serialize>(
    project_id: &str,
    items: Vec<T>,
    page: &WorkbenchPageInfo,
) -> String {
    let mut resp: WorkbenchSuccess<Vec<T>> = WorkbenchSuccess::new(project_id, items);
    resp.page = Some(page.clone());
    serde_json::to_string(&resp).unwrap()
}

/// Run the WB1 loopback HTTP server.
pub fn run_serve(store_path: &str, project: &str) -> Result<()> {
    let store = Store::open(store_path).context("opening store")?;
    let project = project.to_string();

    let listener = TcpListener::bind("127.0.0.1:0").context("binding to loopback")?;
    let addr = listener.local_addr().context("getting local address")?;
    let token = uuid::Uuid::new_v4().to_string();

    eprintln!("Rho WB1 server listening on http://{}", addr);
    eprintln!("Authorization: Bearer {}", token);

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Reject non-loopback
        if let Ok(peer) = stream.peer_addr()
            && !peer.ip().is_loopback()
        {
            write_response(&mut stream, 403, "text/plain", "forbidden: loopback only");
            continue;
        }

        let (path, _body, headers) = match parse_request(&mut stream) {
            Some(req) => req,
            None => {
                write_response(
                    &mut stream,
                    400,
                    "application/json",
                    &json_error(WorkbenchErrorCode::InternalError, "bad request"),
                );
                continue;
            }
        };

        // Check auth
        let auth_header = headers.get("authorization");
        let expected = format!("Bearer {}", token);
        if auth_header.map(|h| h.as_str()) != Some(&expected) {
            write_response(
                &mut stream,
                401,
                "application/json",
                &json_error(WorkbenchErrorCode::InternalError, "unauthorized"),
            );
            continue;
        }

        // Parse query params
        let query_params = if let Some(q) = path.split('?').nth(1) {
            parse_query(q)
        } else {
            HashMap::new()
        };

        let path_segments: Vec<&str> = path
            .split('?')
            .next()
            .unwrap_or("")
            .trim_matches('/')
            .split('/')
            .collect();

        let result = handle_route(&store, &project, &path_segments, &query_params);
        write_response(&mut stream, 200, "application/json", &result);
    }

    Ok(())
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            params.insert(
                urlencoding::decode(k).unwrap_or_default().into_owned(),
                urlencoding::decode(v).unwrap_or_default().into_owned(),
            );
        }
    }
    params
}

fn handle_route(
    store: &Store,
    project: &str,
    segments: &[&str],
    query: &HashMap<String, String>,
) -> String {
    let after = query.get("after").map(|s| s.as_str());
    let page_size: usize = query
        .get("page_size")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);

    match segments {
        ["capabilities"] => {
            let caps = store.workbench_capabilities();
            json_success(project, &caps)
        }

        ["project"] => match store.workbench_project_status(project) {
            Ok(status) => json_success(project, &status),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["workspace"] => match store.workbench_workspace_status(project) {
            Ok(Some(status)) => json_success(project, &status),
            Ok(None) => json_error(
                WorkbenchErrorCode::ProjectUnavailable,
                "no active workspace",
            ),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["runs"] => match store.workbench_run_list(project, after, page_size) {
            Ok(page) => json_success_page(project, page.items, &page.page),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["runs", run_id] => match store.workbench_run_get(project, run_id) {
            Ok(Some(detail)) => json_success(project, &detail),
            Ok(None) => json_error(
                WorkbenchErrorCode::NotFound,
                &format!("run not found: {}", run_id),
            ),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["problems"] => match store.workbench_problem_list(project, after, page_size) {
            Ok(page) => json_success_page(project, page.items, &page.page),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["problems", problem_id] => match store.workbench_problem_get(project, problem_id) {
            Ok(Some(problem)) => json_success(project, &problem),
            Ok(None) => json_error(
                WorkbenchErrorCode::NotFound,
                &format!("problem not found: {}", problem_id),
            ),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["outputs"] => match store.workbench_output_list(project, after, page_size) {
            Ok(page) => json_success_page(project, page.items, &page.page),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["outputs", artifact_id] => match store.workbench_output_get(project, artifact_id) {
            Ok(Some(output)) => json_success(project, &output),
            Ok(None) => json_error(
                WorkbenchErrorCode::NotFound,
                &format!("output not found: {}", artifact_id),
            ),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["environment"] => {
            match store.workbench_environment_evidence_list(project, after, page_size) {
                Ok(page) => json_success_page(project, page.items, &page.page),
                Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
            }
        }

        ["environment", evidence_id] => {
            match store.workbench_environment_evidence_get(project, evidence_id) {
                Ok(Some(evidence)) => json_success(project, &evidence),
                Ok(None) => json_error(
                    WorkbenchErrorCode::NotFound,
                    &format!("evidence not found: {}", evidence_id),
                ),
                Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
            }
        }

        ["approvals"] => match store.workbench_approval_list(project, after, page_size) {
            Ok(page) => json_success_page(project, page.items, &page.page),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["approvals", request_id] => match store.workbench_approval_get(project, request_id) {
            Ok(Some(approval)) => json_success(project, &approval),
            Ok(None) => json_error(
                WorkbenchErrorCode::NotFound,
                &format!("approval not found: {}", request_id),
            ),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        ["provenance", resource_id] => match store.workbench_provenance_get(project, resource_id) {
            Ok(Some(link)) => json_success(project, &link),
            Ok(None) => json_error(
                WorkbenchErrorCode::NotFound,
                &format!("resource not found: {}", resource_id),
            ),
            Err(e) => json_error(WorkbenchErrorCode::InternalError, &e.to_string()),
        },

        _ => json_error(
            WorkbenchErrorCode::NotFound,
            &format!("unknown endpoint: /{}", segments.join("/")),
        ),
    }
}
