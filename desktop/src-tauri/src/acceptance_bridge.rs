//! Debug-only acceptance automation bridge.
//!
//! When built with `debug_assertions` and started with
//! `RHO_ACCEPTANCE_BRIDGE=1` plus `RHO_ACCEPTANCE_OUTPUT` pointing at an
//! existing writable directory, the bridge listens on an ephemeral
//! `127.0.0.1` port, writes `{"port": ..., "pid": ...}` to
//! `$RHO_ACCEPTANCE_OUTPUT/bridge.json`, and serves a minimal HTTP interface
//! (`GET /health`, `POST /eval`, `POST /screenshot`, `POST /window`) for
//! automated acceptance drives. Release builds contain no listener code path;
//! the `acceptance_bridge_result` command stays registered but is fail-closed.

use serde_json::Value;

#[cfg(debug_assertions)]
mod bridge {
    use std::collections::HashMap;
    use std::io::{Error, ErrorKind, Read, Write};
    use std::net::{Ipv4Addr, TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, OnceLock, mpsc};
    use std::time::Duration;

    use serde_json::{Value, json};
    use tauri::{AppHandle, Emitter, Manager};

    use crate::startup_runtime::write_startup_log;

    const MAX_HEADER_BYTES: usize = 64 * 1024;
    const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
    const READ_TIMEOUT: Duration = Duration::from_secs(30);
    const EVAL_TIMEOUT: Duration = Duration::from_secs(300);
    const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(30);
    const MIN_PNG_BYTES: usize = 1024;
    const MAX_CONCURRENT_CONNECTIONS: usize = 8;
    const MAX_SCREENSHOT_NAME_BYTES: usize = 128;

    type Response = (u16, &'static str, Value);

    pub(super) struct BridgeState {
        output_dir: PathBuf,
        pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
        next_id: AtomicU64,
        active: AtomicBool,
        active_connections: AtomicUsize,
    }

    static BRIDGE: OnceLock<Arc<BridgeState>> = OnceLock::new();

    /// Resolve the bridge output directory from the two environment
    /// variables. Returns `None` unless the bridge flag is exactly "1" and
    /// the output directory exists and is writable.
    pub(super) fn resolve_config(bridge: Option<&str>, output: Option<&str>) -> Option<PathBuf> {
        if bridge != Some("1") {
            return None;
        }
        let path = std::fs::canonicalize(PathBuf::from(output?)).ok()?;
        if !path.is_dir() {
            return None;
        }
        let probe = path.join(format!(".rho-acceptance-probe-{}", std::process::id()));
        let _ = std::fs::remove_file(&probe);
        let writable = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .is_ok();
        let _ = std::fs::remove_file(&probe);
        writable.then_some(path)
    }

    /// Create one bridge-owned file without following or replacing an
    /// existing final path. `create_new` is atomic and fails for regular
    /// files and symlinks alike.
    fn write_new_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        if let Err(error) = file.write_all(bytes) {
            let _ = std::fs::remove_file(path);
            return Err(error);
        }
        Ok(())
    }

    fn screenshot_directory(output_dir: &std::path::Path) -> std::io::Result<PathBuf> {
        let directory = output_dir.join("screenshots");
        match std::fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid_data("screenshots directory must not be a symlink"));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(invalid_data(
                    "screenshots path exists but is not a directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                std::fs::create_dir(&directory)?;
            }
            Err(error) => return Err(error),
        }
        let canonical = std::fs::canonicalize(&directory)?;
        if !canonical.starts_with(output_dir) {
            return Err(invalid_data(
                "screenshots directory escapes the output root",
            ));
        }
        Ok(canonical)
    }

    /// Screenshot names are restricted to `[a-z0-9-]` so they can be used
    /// verbatim as file names inside the screenshots directory.
    pub(super) fn sanitize_screenshot_name(name: &str) -> Result<(), String> {
        if name.is_empty() {
            return Err("name must not be empty".to_string());
        }
        if name.len() > MAX_SCREENSHOT_NAME_BYTES {
            return Err(format!(
                "name must not exceed {MAX_SCREENSHOT_NAME_BYTES} bytes"
            ));
        }
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("name may only contain lowercase letters, digits and '-'".to_string());
        }
        Ok(())
    }

    pub(super) fn start(app: &AppHandle) {
        let bridge = std::env::var("RHO_ACCEPTANCE_BRIDGE").ok();
        if bridge.as_deref() != Some("1") {
            return;
        }
        let output = std::env::var("RHO_ACCEPTANCE_OUTPUT").ok();
        let Some(output_dir) = resolve_config(bridge.as_deref(), output.as_deref()) else {
            write_startup_log(
                "Rho acceptance bridge not started: RHO_ACCEPTANCE_OUTPUT must name an existing writable directory",
            );
            return;
        };
        let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
            Ok(listener) => listener,
            Err(error) => {
                write_startup_log(&format!("Rho acceptance bridge bind failed: {error}"));
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(address) => address.port(),
            Err(error) => {
                write_startup_log(&format!(
                    "Rho acceptance bridge could not read its address: {error}"
                ));
                return;
            }
        };
        let descriptor = json!({ "port": port, "pid": std::process::id() });
        let descriptor_path = output_dir.join("bridge.json");
        if let Err(error) = write_new_file(&descriptor_path, descriptor.to_string().as_bytes()) {
            write_startup_log(&format!(
                "Rho acceptance bridge could not write bridge.json: {error}"
            ));
            return;
        }
        let state = Arc::new(BridgeState {
            output_dir,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            active: AtomicBool::new(false),
            active_connections: AtomicUsize::new(0),
        });
        let (activate_tx, activate_rx) = mpsc::sync_channel::<()>(0);
        let handle = app.clone();
        let thread_state = state.clone();
        let spawned = std::thread::Builder::new()
            .name("rho-acceptance-bridge".to_string())
            .spawn(move || {
                if activate_rx.recv().is_err() {
                    return;
                }
                thread_state.active.store(true, Ordering::Release);
                listen(handle, thread_state.clone(), listener);
                thread_state.active.store(false, Ordering::Release);
                let _ = std::fs::remove_file(thread_state.output_dir.join("bridge.json"));
            });
        if let Err(error) = spawned {
            let _ = std::fs::remove_file(&descriptor_path);
            write_startup_log(&format!(
                "Rho acceptance bridge thread could not start: {error}"
            ));
            return;
        }
        if BRIDGE.set(state.clone()).is_err() {
            let _ = std::fs::remove_file(&descriptor_path);
            write_startup_log("Rho acceptance bridge already started");
            return;
        }
        if activate_tx.send(()).is_err() {
            let _ = std::fs::remove_file(&descriptor_path);
            write_startup_log("Rho acceptance bridge thread stopped before activation");
            return;
        }
        write_startup_log(&format!(
            "Rho acceptance bridge listening on 127.0.0.1:{port}"
        ));
    }

    struct ConnectionSlot(Arc<BridgeState>);

    impl Drop for ConnectionSlot {
        fn drop(&mut self) {
            self.0.active_connections.fetch_sub(1, Ordering::AcqRel);
        }
    }

    fn reserve_connection(state: &BridgeState) -> bool {
        state
            .active_connections
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_CONNECTIONS).then_some(active + 1)
            })
            .is_ok()
    }

    fn listen(app: AppHandle, state: Arc<BridgeState>, listener: TcpListener) {
        for connection in listener.incoming() {
            match connection {
                Ok(mut stream) => {
                    if !reserve_connection(&state) {
                        let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
                        let _ = write_json_response(
                            &mut stream,
                            503,
                            "Service Unavailable",
                            &json!({ "ok": false, "error": "too many bridge connections" }),
                        );
                        continue;
                    }
                    let connection_app = app.clone();
                    let connection_state = state.clone();
                    let spawned = std::thread::Builder::new()
                        .name("rho-acceptance-connection".to_string())
                        .spawn(move || {
                            let _slot = ConnectionSlot(connection_state.clone());
                            if let Err(error) =
                                handle_connection(&mut stream, &connection_app, &connection_state)
                            {
                                write_startup_log(&format!(
                                    "Rho acceptance bridge connection failed: {error}"
                                ));
                            }
                        });
                    if let Err(error) = spawned {
                        state.active_connections.fetch_sub(1, Ordering::AcqRel);
                        write_startup_log(&format!(
                            "Rho acceptance bridge connection thread could not start: {error}"
                        ));
                    }
                }
                Err(error) => {
                    write_startup_log(&format!("Rho acceptance bridge accept failed: {error}"));
                }
            }
        }
    }

    fn handle_connection(
        stream: &mut TcpStream,
        app: &AppHandle,
        state: &BridgeState,
    ) -> std::io::Result<()> {
        let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
        let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
        let Some(request) = read_request(stream)? else {
            return Ok(());
        };
        let (status, reason, body) = route(&request, app, state);
        write_json_response(stream, status, reason, &body)
    }

    fn route(request: &HttpRequest, app: &AppHandle, state: &BridgeState) -> Response {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/health") => (200, "OK", json!({ "ok": true })),
            ("POST", "/eval") => handle_eval(request, app, state),
            ("POST", "/screenshot") => handle_screenshot(request, app, state),
            ("POST", "/window") => handle_window(request, app),
            _ => (
                404,
                "Not Found",
                json!({ "ok": false, "error": "unknown route" }),
            ),
        }
    }

    fn handle_eval(request: &HttpRequest, app: &AppHandle, state: &BridgeState) -> Response {
        let body = match parse_json_body(request) {
            Ok(body) => body,
            Err(response) => return response,
        };
        let Some(js) = body.get("js").and_then(Value::as_str) else {
            return bad_request("body must contain a string field \"js\"");
        };
        let id = state.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        state.pending.lock().unwrap().insert(id, tx);
        if let Err(error) = app.emit("rho://acceptance-eval", json!({ "id": id, "js": js })) {
            state.pending.lock().unwrap().remove(&id);
            return internal_error(format!("could not emit acceptance eval event: {error}"));
        }
        match rx.recv_timeout(EVAL_TIMEOUT) {
            Ok(Ok(value)) => (200, "OK", json!({ "ok": true, "value": value })),
            Ok(Err(error)) => (200, "OK", json!({ "ok": false, "error": error })),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                state.pending.lock().unwrap().remove(&id);
                (
                    504,
                    "Gateway Timeout",
                    json!({ "ok": false, "error": "eval timed out" }),
                )
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                internal_error("eval result channel disconnected")
            }
        }
    }

    fn handle_screenshot(request: &HttpRequest, app: &AppHandle, state: &BridgeState) -> Response {
        let body = match parse_json_body(request) {
            Ok(body) => body,
            Err(response) => return response,
        };
        let Some(name) = body.get("name").and_then(Value::as_str) else {
            return bad_request("body must contain a string field \"name\"");
        };
        if let Err(error) = sanitize_screenshot_name(name) {
            return bad_request(error);
        }
        capture_screenshot(app, state, name)
    }

    #[cfg(target_os = "macos")]
    fn capture_screenshot(app: &AppHandle, state: &BridgeState, name: &str) -> Response {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        let handle = app.clone();
        let dispatch = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window("main") else {
                let _ = tx.send(Err("main window not found".to_string()));
                return;
            };
            let block_tx = tx.clone();
            if let Err(error) = window.with_webview(move |webview| {
                start_wkweb_snapshot(webview.inner(), block_tx);
            }) {
                let _ = tx.send(Err(format!("could not access the webview: {error}")));
            }
        });
        if let Err(error) = dispatch {
            return internal_error(format!("main thread dispatch failed: {error}"));
        }
        let png = match rx.recv_timeout(MAIN_THREAD_TIMEOUT) {
            Ok(Ok(png)) => png,
            Ok(Err(error)) => return internal_error(error),
            Err(_) => return internal_error("screenshot timed out".to_string()),
        };
        if png.len() < MIN_PNG_BYTES {
            return internal_error(format!(
                "screenshot capture too small ({} bytes)",
                png.len()
            ));
        }
        let directory = match screenshot_directory(&state.output_dir) {
            Ok(directory) => directory,
            Err(error) => {
                return internal_error(format!("could not prepare screenshots directory: {error}"));
            }
        };
        let path = directory.join(format!("{name}.png"));
        if let Err(error) = write_new_file(&path, &png) {
            return internal_error(format!("could not write screenshot: {error}"));
        }
        (
            200,
            "OK",
            json!({ "ok": true, "path": path.to_string_lossy(), "bytes": png.len() }),
        )
    }

    #[cfg(not(target_os = "macos"))]
    fn capture_screenshot(app: &AppHandle, state: &BridgeState, name: &str) -> Response {
        let _ = (app, state, name);
        screenshot_not_implemented()
    }

    // Kept available in macOS test builds so the non-macOS response shape has
    // executable regression coverage without adding dead code to normal
    // macOS debug builds.
    #[cfg(any(not(target_os = "macos"), test))]
    fn screenshot_not_implemented() -> Response {
        (
            501,
            "Not Implemented",
            json!({ "ok": false, "error": "screenshot not implemented on this platform" }),
        )
    }

    /// Kick off an asynchronous `WKWebView` viewport snapshot; the completion
    /// block delivers the PNG bytes through `tx`. Must run on the main thread.
    #[cfg(target_os = "macos")]
    fn start_wkweb_snapshot(
        webview_ptr: *mut std::ffi::c_void,
        tx: mpsc::Sender<Result<Vec<u8>, String>>,
    ) {
        use objc2_web_kit::WKWebView;

        if webview_ptr.is_null() {
            let _ = tx.send(Err("null WKWebView handle".to_string()));
            return;
        }
        // SAFETY: `PlatformWebview::inner()` is documented by tauri as the
        // live WKWebView pointer, and this closure runs on the main thread.
        let webview: &WKWebView = unsafe { &*(webview_ptr as *const WKWebView) };
        let handler = block2::RcBlock::new(
            move |image: *mut objc2_app_kit::NSImage, error: *mut objc2_foundation::NSError| {
                let _ = tx.send(encode_snapshot_png(image, error));
            },
        );
        // SAFETY: a `None` configuration captures the current visible
        // viewport; WebKit copies the completion handler block.
        unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
    }

    #[cfg(target_os = "macos")]
    fn encode_snapshot_png(
        image: *mut objc2_app_kit::NSImage,
        error: *mut objc2_foundation::NSError,
    ) -> Result<Vec<u8>, String> {
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey};
        use objc2_foundation::NSDictionary;

        if !error.is_null() {
            // SAFETY: non-null NSError pointer delivered by WebKit.
            let description = unsafe { &*error }.localizedDescription().to_string();
            return Err(format!("snapshot failed: {description}"));
        }
        if image.is_null() {
            return Err("snapshot returned no image".to_string());
        }
        // SAFETY: non-null NSImage pointer delivered by WebKit.
        let image = unsafe { &*image };
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| "snapshot TIFF representation failed".to_string())?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| "snapshot bitmap representation failed".to_string())?;
        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
        // SAFETY: an empty properties dictionary is valid for PNG output.
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or_else(|| "snapshot PNG encoding failed".to_string())?;
        Ok(png.to_vec())
    }

    fn handle_window(request: &HttpRequest, app: &AppHandle) -> Response {
        let body = match parse_json_body(request) {
            Ok(body) => body,
            Err(response) => return response,
        };
        let (Some(width), Some(height)) = (
            body.get("width").and_then(Value::as_f64),
            body.get("height").and_then(Value::as_f64),
        ) else {
            return bad_request("body must contain numeric \"width\" and \"height\"");
        };
        if !valid_dimension(width) || !valid_dimension(height) {
            return bad_request("width and height must be between 1 and 16384");
        }
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let result = match handle.get_webview_window("main") {
                Some(window) => window
                    .set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
                    .map_err(|error| error.to_string()),
                None => Err("main window not found".to_string()),
            };
            let _ = tx.send(result);
        }) {
            return internal_error(format!("main thread dispatch failed: {error}"));
        }
        match rx.recv_timeout(MAIN_THREAD_TIMEOUT) {
            Ok(Ok(())) => (200, "OK", json!({ "ok": true })),
            Ok(Err(error)) => internal_error(error),
            Err(_) => internal_error("window resize timed out".to_string()),
        }
    }

    fn valid_dimension(value: f64) -> bool {
        value.is_finite() && (1.0..=16384.0).contains(&value)
    }

    pub(super) fn is_active() -> bool {
        BRIDGE
            .get()
            .is_some_and(|state| state.active.load(Ordering::Acquire))
    }

    pub(super) fn deliver_result(
        id: u64,
        ok: bool,
        value: Option<Value>,
        error: Option<String>,
    ) -> Result<(), String> {
        let Some(state) = BRIDGE
            .get()
            .filter(|state| state.active.load(Ordering::Acquire))
        else {
            return Err("acceptance bridge is not active".to_string());
        };
        let sender = state
            .pending
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or_else(|| format!("no pending acceptance eval with id {id}"))?;
        let result = if ok {
            Ok(value.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "eval failed".to_string()))
        };
        sender
            .send(result)
            .map_err(|_| "eval waiter is no longer listening".to_string())
    }

    fn parse_json_body(request: &HttpRequest) -> Result<Value, Response> {
        serde_json::from_slice(&request.body)
            .map_err(|error| bad_request(format!("request body is not valid JSON: {error}")))
    }

    fn bad_request(message: impl Into<String>) -> Response {
        (
            400,
            "Bad Request",
            json!({ "ok": false, "error": message.into() }),
        )
    }

    fn internal_error(message: impl Into<String>) -> Response {
        (
            500,
            "Internal Server Error",
            json!({ "ok": false, "error": message.into() }),
        )
    }

    pub(super) struct HttpRequest {
        method: String,
        path: String,
        body: Vec<u8>,
    }

    /// Minimal HTTP/1.1 request parser: reads the request line and headers up
    /// to CRLFCRLF, then exactly `Content-Length` body bytes. Returns
    /// `Ok(None)` when the peer closes before sending anything.
    pub(super) fn read_request(reader: &mut impl Read) -> std::io::Result<Option<HttpRequest>> {
        let mut buffer = Vec::with_capacity(4096);
        let mut chunk = [0u8; 8192];
        let header_end = loop {
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break position;
            }
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                return Ok(None);
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.len() > MAX_HEADER_BYTES {
                return Err(invalid_data("request headers too large"));
            }
        };
        let header_text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
        let mut lines = header_text.split("\r\n");
        let request_line = lines.next().unwrap_or_default();
        let mut parts = request_line.split_whitespace();
        let (Some(method), Some(path)) = (parts.next(), parts.next()) else {
            return Err(invalid_data("malformed request line"));
        };
        let method = method.to_string();
        let path = path.to_string();
        let mut content_length = 0usize;
        for line in lines {
            if let Some((name, value)) = line.split_once(':')
                && name.trim().eq_ignore_ascii_case("content-length")
            {
                content_length = value
                    .trim()
                    .parse()
                    .map_err(|_| invalid_data("invalid Content-Length header"))?;
            }
        }
        if content_length > MAX_BODY_BYTES {
            return Err(invalid_data("request body too large"));
        }
        let mut body = buffer.split_off(header_end + 4);
        while body.len() < content_length {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                return Err(Error::new(
                    ErrorKind::UnexpectedEof,
                    "request body truncated",
                ));
            }
            body.extend_from_slice(&chunk[..read]);
            if body.len() > MAX_BODY_BYTES {
                return Err(invalid_data("request body too large"));
            }
        }
        body.truncate(content_length);
        Ok(Some(HttpRequest { method, path, body }))
    }

    pub(super) fn write_json_response(
        writer: &mut impl Write,
        status: u16,
        reason: &str,
        body: &Value,
    ) -> std::io::Result<()> {
        let payload = serde_json::to_vec(body)
            .map_err(|error| invalid_data(format!("could not encode response: {error}")))?;
        let head = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        writer.write_all(head.as_bytes())?;
        writer.write_all(&payload)?;
        writer.flush()
    }

    fn invalid_data(message: impl Into<String>) -> Error {
        Error::new(ErrorKind::InvalidData, message.into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Cursor;

        #[test]
        fn resolve_config_requires_bridge_flag() {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().to_str().unwrap();
            assert_eq!(resolve_config(None, Some(path)), None);
            assert_eq!(resolve_config(Some("0"), Some(path)), None);
            assert_eq!(resolve_config(Some("true"), Some(path)), None);
            let canonical = std::fs::canonicalize(directory.path()).unwrap();
            assert_eq!(
                resolve_config(Some("1"), Some(path)).as_deref(),
                Some(canonical.as_path())
            );
        }

        #[test]
        fn resolve_config_requires_existing_writable_directory() {
            let directory = tempfile::tempdir().unwrap();
            assert_eq!(resolve_config(Some("1"), None), None);
            assert_eq!(resolve_config(Some("1"), Some("")), None);
            let missing = directory.path().join("does-not-exist");
            assert_eq!(
                resolve_config(Some("1"), Some(missing.to_str().unwrap())),
                None
            );
            let file = directory.path().join("a-file");
            std::fs::write(&file, b"x").unwrap();
            assert_eq!(
                resolve_config(Some("1"), Some(file.to_str().unwrap())),
                None
            );
        }

        #[test]
        fn bridge_owned_files_never_replace_existing_targets() {
            let directory = tempfile::tempdir().unwrap();
            let target = directory.path().join("bridge.json");
            std::fs::write(&target, b"existing").unwrap();
            let error = write_new_file(&target, b"replacement").unwrap_err();
            assert_eq!(error.kind(), ErrorKind::AlreadyExists);
            assert_eq!(std::fs::read(&target).unwrap(), b"existing");
        }

        #[cfg(unix)]
        #[test]
        fn bridge_owned_files_and_directories_reject_symlinks() {
            use std::os::unix::fs::symlink;

            let directory = tempfile::tempdir().unwrap();
            let outside_file = directory.path().join("outside.json");
            std::fs::write(&outside_file, b"outside").unwrap();
            let descriptor = directory.path().join("bridge.json");
            symlink(&outside_file, &descriptor).unwrap();
            assert!(write_new_file(&descriptor, b"replacement").is_err());
            assert_eq!(std::fs::read(&outside_file).unwrap(), b"outside");

            let output = directory.path().join("output");
            let outside_directory = directory.path().join("outside-screenshots");
            std::fs::create_dir(&output).unwrap();
            std::fs::create_dir(&outside_directory).unwrap();
            symlink(&outside_directory, output.join("screenshots")).unwrap();
            assert!(screenshot_directory(&output).is_err());
        }

        #[test]
        fn screenshot_directory_and_files_are_created_exclusively() {
            let directory = tempfile::tempdir().unwrap();
            let output = std::fs::canonicalize(directory.path()).unwrap();
            let screenshots = screenshot_directory(&output).unwrap();
            assert!(screenshots.starts_with(&output));
            let target = screenshots.join("frame.png");
            write_new_file(&target, b"first").unwrap();
            assert!(write_new_file(&target, b"second").is_err());
            assert_eq!(std::fs::read(target).unwrap(), b"first");
        }

        #[test]
        fn connection_reservations_are_bounded_and_recover_after_drop() {
            let directory = tempfile::tempdir().unwrap();
            let state = Arc::new(BridgeState {
                output_dir: std::fs::canonicalize(directory.path()).unwrap(),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                active: AtomicBool::new(false),
                active_connections: AtomicUsize::new(0),
            });
            let mut slots = Vec::new();
            for _ in 0..MAX_CONCURRENT_CONNECTIONS {
                assert!(reserve_connection(&state));
                slots.push(ConnectionSlot(state.clone()));
            }
            assert!(!reserve_connection(&state));
            drop(slots.pop());
            assert!(reserve_connection(&state));
            slots.push(ConnectionSlot(state.clone()));
            drop(slots);
            assert_eq!(state.active_connections.load(Ordering::Acquire), 0);
        }

        #[test]
        fn screenshot_name_accepts_contract_charset() {
            assert!(sanitize_screenshot_name("s1-console").is_ok());
            assert!(sanitize_screenshot_name("a").is_ok());
            assert!(sanitize_screenshot_name("0123-").is_ok());
            assert!(sanitize_screenshot_name("-").is_ok());
        }

        #[test]
        fn screenshot_name_rejects_anything_else() {
            for name in [
                "",
                "S1",
                "with space",
                "under_score",
                "dot.png",
                "slash/name",
                "../escape",
                "ümlaut",
            ] {
                assert!(sanitize_screenshot_name(name).is_err(), "name: {name}");
            }
            assert!(sanitize_screenshot_name(&"a".repeat(MAX_SCREENSHOT_NAME_BYTES + 1)).is_err());
        }

        #[test]
        fn unsupported_screenshot_response_is_well_formed() {
            let (status, reason, body) = screenshot_not_implemented();
            assert_eq!(status, 501);
            assert_eq!(reason, "Not Implemented");
            assert_eq!(body["ok"], false);
        }

        #[test]
        fn read_request_parses_get_without_body() {
            let mut cursor =
                Cursor::new(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".to_vec());
            let request = read_request(&mut cursor).unwrap().unwrap();
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/health");
            assert!(request.body.is_empty());
        }

        #[test]
        fn read_request_parses_post_with_content_length() {
            let body = b"{\"js\":\"1+1\"}";
            let raw = format!(
                "POST /eval HTTP/1.1\r\ncontent-length: {}\r\nX-Test: yes\r\n\r\n",
                body.len()
            );
            let mut bytes = raw.into_bytes();
            bytes.extend_from_slice(body);
            // Trailing bytes beyond Content-Length must be ignored.
            bytes.extend_from_slice(b"EXTRA");
            let mut cursor = Cursor::new(bytes);
            let request = read_request(&mut cursor).unwrap().unwrap();
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/eval");
            assert_eq!(request.body, body);
        }

        #[test]
        fn read_request_returns_none_on_empty_connection() {
            let mut cursor = Cursor::new(Vec::new());
            assert!(read_request(&mut cursor).unwrap().is_none());
        }

        #[test]
        fn read_request_rejects_malformed_request_line() {
            let mut cursor = Cursor::new(b"nonsense\r\n\r\n".to_vec());
            assert!(read_request(&mut cursor).is_err());
        }

        #[test]
        fn read_request_rejects_truncated_body() {
            let mut cursor =
                Cursor::new(b"POST /eval HTTP/1.1\r\nContent-Length: 10\r\n\r\n{}".to_vec());
            assert!(read_request(&mut cursor).is_err());
        }

        #[test]
        fn read_request_rejects_oversized_body() {
            let raw = format!(
                "POST /eval HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
                MAX_BODY_BYTES + 1
            );
            let mut cursor = Cursor::new(raw.into_bytes());
            assert!(read_request(&mut cursor).is_err());
        }

        #[test]
        fn write_json_response_emits_length_and_close() {
            let mut output = Vec::new();
            write_json_response(&mut output, 200, "OK", &json!({ "ok": true })).unwrap();
            let text = String::from_utf8(output).unwrap();
            assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
            assert!(text.contains("Content-Length: 11\r\n"));
            assert!(text.contains("Connection: close\r\n"));
            assert!(text.ends_with("{\"ok\":true}"));
        }
    }
}

#[cfg(debug_assertions)]
pub(crate) fn start_if_enabled(app: &tauri::AppHandle) {
    bridge::start(app);
}

/// Reports whether the acceptance bridge is active. Registered in every
/// build so the frontend probe behaves identically in debug and release.
#[tauri::command]
pub(crate) fn acceptance_bridge_active() -> bool {
    bridge_active_impl()
}

#[cfg(debug_assertions)]
fn bridge_active_impl() -> bool {
    bridge::is_active()
}

#[cfg(not(debug_assertions))]
fn bridge_active_impl() -> bool {
    false
}

/// Delivers the frontend result of an `rho://acceptance-eval` request back to
/// the waiting HTTP caller. Fail-closed whenever the bridge is not active.
#[tauri::command]
pub(crate) fn acceptance_bridge_result(
    id: u64,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    deliver_result(id, ok, value, error)
}

#[cfg(debug_assertions)]
fn deliver_result(
    id: u64,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    bridge::deliver_result(id, ok, value, error)
}

#[cfg(not(debug_assertions))]
fn deliver_result(
    id: u64,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let _ = (id, ok, value, error);
    Err("acceptance bridge is not active".to_string())
}

#[cfg(test)]
mod command_tests {
    use super::*;

    #[test]
    fn commands_fail_closed_without_an_active_bridge() {
        assert!(!acceptance_bridge_active());
        assert_eq!(
            acceptance_bridge_result(7, true, Some(Value::Null), None),
            Err("acceptance bridge is not active".to_string())
        );
    }
}
