//! Annotation HTTP verification: frozen evidence, CAS, history and boundaries.
//! No R session, native Agent or model is started.
use super::*;
use axum::body::{Body, to_bytes};
use rho_contract::*;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn post(app: &Router, path: &str, body: Value, token: &str, window: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("POST").uri(path).header(header::HOST, "127.0.0.1:10001")
        .header(header::AUTHORIZATION, token).header(header::CONTENT_TYPE, "application/json");
    if let Some(window) = window { builder = builder.header("x-rho-studio-window", window); }
    let response = app.clone().oneshot(builder.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), MAX_REPLY).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"text": String::from_utf8_lossy(&bytes)})))
}
async fn registered(state: &AppState) -> (Arc<NextHost>, String, ApplicationWindowRef) {
    let host = state.hosting.read().await.selected.as_ref().unwrap().host.clone();
    let project = state.hosting.read().await.info().project_root.unwrap();
    let mut context = NextHost::local_context();
    context.connection_id = "studio:note-window".into();
    let result = host.dispatch(&context, HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
        window_id: "note-window".into(), incarnation: "note-life".into(), label: "Annotation fixture".into(), previous_session: None,
    })).await.unwrap();
    let ApplicationBridgeReply::Registered(registration) = serde_json::from_value(result).unwrap() else { panic!() };
    (host, project, registration.session.window)
}
async fn call(app: &Router, path: &str, body: Value) -> Value {
    let (status, value) = post(app, path, body, "Bearer fixture-only", Some("note-window")).await;
    assert!(status.is_success(), "{status}: {value}");
    value
}

#[tokio::test]
async fn annotations_freeze_owner_evidence_and_bind_history_to_the_source_version() {
    let (_directory, state, app) = tests::fixture().await;
    let (_host, project, window) = registered(&state).await;
    std::fs::write(std::path::Path::new(&project).join("analysis.R"), "fit <- lm(y ~ x)\nsummary(fit)\n").unwrap();
    let command = |request_id: &str, command: Value| json!({"project_root": project, "window": window, "request_id": request_id, "command": command});
    let query = |query: Value| json!({"project_root": project, "window": window, "query": query});
    let selection = json!({"source": "files", "label": "analysis.R", "reference": {"path": "analysis.R"}, "inclusion": "text"});

    // Boundaries: bearer and window header are required, like every Studio request.
    let (status, _) = post(&app, "/api/annotations/query", query(json!({"kind": "list", "limit": 10})), "Bearer wrong", Some("note-window")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, error) = post(&app, "/api/annotations/query", query(json!({"kind": "list", "limit": 10})), "Bearer fixture-only", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["diagnostic"]["code"], "access_denied");

    let anchor = json!({"kind": "text_quote", "quote": "lm(y ~ x)", "start": 7, "end": 16, "unit": "utf16"});
    let frozen = call(&app, "/api/annotations/command", command("freeze-1", json!({"kind": "freeze", "selection": selection, "session": null, "anchor": anchor}))).await;
    let evidence_id = frozen["outcome"]["evidence_id"].as_str().unwrap().to_owned();
    let evidence = call(&app, "/api/annotations/query", query(json!({"kind": "evidence", "evidence_id": evidence_id}))).await["evidence"].clone();
    assert_eq!(evidence["source"]["owner"], "file");
    assert_eq!(evidence["source"]["source_id"], "file:analysis.R");
    let original_version = evidence["source"]["source_version"].as_str().unwrap().to_owned();
    assert!(original_version.starts_with("sha256:"), "the owner hash is the version: {original_version}");
    assert_eq!(evidence["selection"]["reference"]["expected_sha256"], json!(original_version), "the normalized owner reference is frozen");
    assert_eq!(evidence["fragment"]["quote_found_in_observation"], json!(true));

    let created = call(&app, "/api/annotations/command", command("create-1", json!({"kind": "create", "evidence_id": evidence_id, "note": "Is the intercept intended?", "labels": ["question"], "marks": [], "continued_from": null}))).await;
    let replay = call(&app, "/api/annotations/command", command("create-1", json!({"kind": "create", "evidence_id": evidence_id, "note": "Is the intercept intended?", "labels": ["question"], "marks": [], "continued_from": null}))).await;
    assert_eq!(created, replay);
    let annotation = created["outcome"]["annotation"].clone();
    assert_eq!(annotation["revision"], 1);
    let (status, error) = post(&app, "/api/annotations/command", command("create-1", json!({"kind": "create", "evidence_id": evidence_id, "note": "changed", "labels": [], "marks": [], "continued_from": null})), "Bearer fixture-only", Some("note-window")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["diagnostic"]["code"], "idempotency_conflict");
    assert_eq!(error["submission"], "accepted", "the original request was durably accepted");

    let preview = call(&app, "/api/annotations/query", query(json!({"kind": "preview", "annotation": annotation, "session": null}))).await["preview"].clone();
    assert_eq!(preview["status"], "current");
    assert_eq!(preview["availability"], "available");
    assert_eq!(preview["current_version"], json!(original_version));

    // Update under CAS; a stale expected revision from another window conflicts and changes nothing.
    let updated = call(&app, "/api/annotations/command", command("update-1", json!({"kind": "update", "expected": annotation, "note": "Intercept is implicit in lm().", "labels": [], "marks": []}))).await;
    assert_eq!(updated["outcome"]["annotation"]["revision"], 2);
    let (status, error) = post(&app, "/api/annotations/command", command("update-stale", json!({"kind": "update", "expected": annotation, "note": "Other window", "labels": [], "marks": []})), "Bearer fixture-only", Some("note-window")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["diagnostic"]["code"], "content_changed");
    assert_eq!(error["submission"], "rejected");
    let list = call(&app, "/api/annotations/query", query(json!({"kind": "list", "source_id": "file:analysis.R", "limit": 10}))).await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["items"][0]["revision"]["note"], "Intercept is implicit in lm().");
    assert_eq!(list["items"][0]["source"]["source_version"], json!(original_version));

    // The owner publishes a new version: the note becomes historical, never moved.
    std::fs::write(std::path::Path::new(&project).join("analysis.R"), "fit <- lm(y ~ x + z)\nsummary(fit)\n").unwrap();
    let historical = call(&app, "/api/annotations/query", query(json!({"kind": "preview", "annotation": updated["outcome"]["annotation"], "session": null}))).await["preview"].clone();
    assert_eq!(historical["status"], "historical");
    assert_eq!(historical["availability"], "available");
    assert_ne!(historical["current_version"], json!(original_version));
    assert_eq!(historical["evidence"]["source"]["source_version"], json!(original_version), "evidence keeps the original version");
    assert_eq!(historical["revision"]["note"], "Intercept is implicit in lm().");

    // Continue the idea on the new version with an explicit link.
    let new_evidence = call(&app, "/api/annotations/command", command("freeze-2", json!({"kind": "freeze", "selection": selection, "session": null, "anchor": {"kind": "whole_item"}}))).await["outcome"]["evidence_id"].clone();
    let continued = call(&app, "/api/annotations/command", command("create-2", json!({"kind": "create", "evidence_id": new_evidence, "note": "Still implicit with z.", "labels": [], "marks": [], "continued_from": updated["outcome"]["annotation"]}))).await;
    let read = call(&app, "/api/annotations/query", query(json!({"kind": "read", "annotation": continued["outcome"]["annotation"]}))).await;
    assert_eq!(read["revision"]["continued_from"], updated["outcome"]["annotation"]);
    assert_ne!(read["evidence"]["source"]["source_version"], json!(original_version));
    let list = call(&app, "/api/annotations/query", query(json!({"kind": "list", "source_id": "file:analysis.R", "limit": 10}))).await;
    assert_eq!(list["items"].as_array().unwrap().len(), 2);

    // The Agent reads the same note through the context path with its original evidence.
    let context = call(&app, "/api/agents/tasks/query", json!({"project_root": project, "query": {"kind": "context_preview", "window": window,
        "selection": {"source": "annotations", "label": "note", "reference": {"annotation": updated["outcome"]["annotation"]}, "inclusion": "text"}}})).await["preview"].clone();
    assert!(context["text"].as_str().unwrap().contains("Intercept is implicit in lm()."));
    assert!(context["text"].as_str().unwrap().contains(&original_version));
    assert_eq!(context["native_data"]["source"]["source_version"], json!(original_version));
    assert!(context["image_base64"].is_null());

    // Delete is a tombstone: history stays readable, the list hides it, and no revision can revive it.
    let deleted = call(&app, "/api/annotations/command", command("delete-1", json!({"kind": "delete", "expected": updated["outcome"]["annotation"]}))).await;
    assert_eq!(deleted["outcome"]["annotation"]["revision"], 3);
    let list = call(&app, "/api/annotations/query", query(json!({"kind": "list", "source_id": "file:analysis.R", "limit": 10}))).await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(call(&app, "/api/annotations/query", query(json!({"kind": "read", "annotation": annotation}))).await["revision"]["note"], "Is the intercept intended?");
    let (status, _) = post(&app, "/api/agents/tasks/query", json!({"project_root": project, "query": {"kind": "context_preview", "window": window,
        "selection": {"source": "annotations", "label": "note", "reference": {"annotation": deleted["outcome"]["annotation"]}, "inclusion": "text"}}}), "Bearer fixture-only", Some("note-window")).await;
    assert!(!status.is_success(), "deleted notes are not Agent context");
    assert!(!state.task_agents.has_live().await);
    assert!(!state.component_agents.has_live().await);
}

#[tokio::test]
async fn captured_views_are_verified_stored_and_served_with_marks() {
    let (_directory, state, app) = tests::fixture().await;
    let (_host, project, window) = registered(&state).await;
    std::fs::write(std::path::Path::new(&project).join("plot.R"), "plot(1)\n").unwrap();
    let command = |request_id: &str, command: Value| json!({"project_root": project, "window": window, "request_id": request_id, "command": command});
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png);
    let (status, error) = post(&app, "/api/annotations/command", command("capture-bad", json!({"kind": "capture", "mime_type": "image/png", "width": 10, "height": 10, "base64": "bm90IGFuIGltYWdl", "original_media": false})), "Bearer fixture-only", Some("note-window")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    let captured = call(&app, "/api/annotations/command", command("capture-1", json!({"kind": "capture", "mime_type": "image/png", "width": 640, "height": 480, "base64": encoded, "original_media": false}))).await;
    let capture = captured["outcome"]["capture"].clone();
    assert_eq!(capture["byte_size"], png.len());
    let response = app.clone().oneshot(Request::builder().method("POST").uri("/api/annotations/capture").header(header::HOST, "127.0.0.1:10001")
        .header(header::AUTHORIZATION, "Bearer fixture-only").header("x-rho-studio-window", "note-window").header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"project_root": project, "window": window, "capture_id": capture["capture_id"]}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(to_bytes(response.into_body(), MAX_REPLY).await.unwrap().to_vec(), png);

    let selection = json!({"source": "files", "label": "plot.R", "reference": {"path": "plot.R"}, "inclusion": "summary"});
    let mut wrong = capture.clone();
    wrong["width"] = json!(1);
    let (status, _) = post(&app, "/api/annotations/command", command("freeze-wrong", json!({"kind": "freeze", "selection": selection, "session": null, "anchor": {"kind": "captured_view", "capture": wrong}})), "Bearer fixture-only", Some("note-window")).await;
    assert_eq!(status, StatusCode::CONFLICT, "a capture reference must match the stored bytes");
    let evidence_id = call(&app, "/api/annotations/command", command("freeze-1", json!({"kind": "freeze", "selection": selection, "session": null, "anchor": {"kind": "captured_view", "capture": capture}}))).await["outcome"]["evidence_id"].clone();
    let marks = json!([{"kind": "rectangle", "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1}, {"kind": "arrow", "from": {"x": 0.5, "y": 0.5}, "to": {"x": 0.7, "y": 0.2}}, {"kind": "text", "x": 0.7, "y": 0.1, "text": "Outlier?"}]);
    let created = call(&app, "/api/annotations/command", command("create-1", json!({"kind": "create", "evidence_id": evidence_id, "note": "", "labels": ["change_request"], "marks": marks, "continued_from": null}))).await;
    let read = call(&app, "/api/annotations/query", json!({"project_root": project, "window": window, "query": {"kind": "read", "annotation": created["outcome"]["annotation"]}})).await;
    assert_eq!(read["revision"]["marks"], marks);
    assert_eq!(read["evidence"]["anchor"]["kind"], "captured_view");
    // Image inclusion delivers the exact capture bytes; text inclusion states the marks without an image.
    let with_image = call(&app, "/api/agents/tasks/query", json!({"project_root": project, "query": {"kind": "context_preview", "window": window,
        "selection": {"source": "annotations", "label": "marks", "reference": {"annotation": created["outcome"]["annotation"]}, "inclusion": "image"}}})).await["preview"].clone();
    assert_eq!(with_image["image_mime_type"], "image/png");
    assert_eq!(with_image["native_data"]["preview_sha256"], capture["sha256"]);
    assert_eq!(with_image["native_data"]["marks"], marks);
    let text_only = call(&app, "/api/agents/tasks/query", json!({"project_root": project, "query": {"kind": "context_preview", "window": window,
        "selection": {"source": "annotations", "label": "marks", "reference": {"annotation": created["outcome"]["annotation"]}, "inclusion": "text"}}})).await["preview"].clone();
    assert!(text_only["image_base64"].is_null());
    assert!(text_only["text"].as_str().unwrap().contains("captured_view"));
}

#[tokio::test]
async fn html_views_need_a_verified_artifact_and_serve_isolated_documents_without_the_bearer() {
    let (_directory, state, app) = tests::fixture().await;
    let project = state.hosting.read().await.info().project_root.unwrap();
    let fake = json!({"operation_id": "op_missing", "sequence": 1, "mime_type": "text/html", "byte_size": 12, "sha256": "sha256:0", "display_id": null});
    let (status, _) = post(&app, "/api/html/token", json!({"project_root": project, "reference": fake}), "Bearer fixture-only", None).await;
    assert_eq!(status, StatusCode::CONFLICT, "an unknown artifact never receives a view token");
    let image = json!({"operation_id": "op_missing", "sequence": 1, "mime_type": "image/png", "byte_size": 12, "sha256": "sha256:0", "display_id": null});
    let (status, _) = post(&app, "/api/html/token", json!({"project_root": project, "reference": image}), "Bearer fixture-only", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let response = app.clone().oneshot(Request::builder().uri(format!("/view/html/{}", "a".repeat(64))).header(header::HOST, "127.0.0.1:10001").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND, "unknown tokens are not found, and the route needs no bearer");
    let response = app.clone().oneshot(Request::builder().uri("/view/html/../app.js").header(header::HOST, "127.0.0.1:10001").body(Body::empty()).unwrap()).await.unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    let shell = app.clone().oneshot(Request::builder().uri("/").header(header::HOST, "127.0.0.1:10001").body(Body::empty()).unwrap()).await.unwrap();
    let policy = shell.headers()["content-security-policy"].to_str().unwrap().to_owned();
    assert!(policy.contains("frame-src 'self'"), "the shell admits same-origin isolated frames: {policy}");
    assert!(policy.contains("frame-ancestors 'none'"));
}
