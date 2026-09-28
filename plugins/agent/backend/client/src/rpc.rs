use futures::StreamExt;
use rho_agent_api::{
    AgentClientSession, AgentDecision, AgentDecisionOption, AgentMessage, AgentProvider,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{Mutex as AsyncMutex, oneshot},
};
use tokio_util::codec::{FramedRead, LinesCodec};

type Reply = oneshot::Sender<Result<Value, String>>;
pub(crate) struct CallTicket {
    id: u64,
    method: String,
    receiver: oneshot::Receiver<Result<Value, String>>,
}
struct PendingReply {
    sender: Reply,
    method: String,
    session: Option<String>,
    request: Option<String>,
}
type DecisionReplies = HashMap<u64, (Value, HashMap<String, Value>)>;
const MAX_TEXT: usize = 256 * 1024;
// MCP allows 8 MiB replies. A native protocol envelope may JSON-escape the
// embedded reply, so reserve space for that envelope without retaining it all.
const MAX_FRAME: usize = 16 * 1024 * 1024;
pub(crate) struct Buffer {
    pub session: Option<AgentClientSession>,
    pub started: Option<Instant>,
    pub turn: Option<String>,
    pub requests: HashMap<String, String>,
}
pub(crate) struct Rpc {
    provider: AgentProvider,
    writer: AsyncMutex<Option<ChildStdin>>,
    child: AsyncMutex<Option<Child>>,
    replies: Arc<Mutex<HashMap<u64, PendingReply>>>,
    decisions: Arc<Mutex<DecisionReplies>>,
    tool_calls: Mutex<Vec<(String, String, String)>>,
    assistant_boundary: AtomicBool,
    acp_config: Mutex<HashMap<String, Value>>,
    next: AtomicU64,
    closed: AtomicBool,
    pub buffer: Arc<Mutex<Buffer>>,
    pub observer: Mutex<crate::observation::Observer>,
    pub capabilities: Mutex<rho_agent_api::AgentNativeCapabilities>,
    pub changes: tokio::sync::Notify,
    pub owner_marker: String,
    secret: String,
    owned_home: Option<PathBuf>,
}
impl Drop for Rpc {
    fn drop(&mut self) {
        // Cancellation can drop a metadata probe before its explicit close.
        // Dropping the owned child requests kill before private copies are removed.
        self.child.get_mut().take();
        if let Some(home) = &self.owned_home {
            let _ = std::fs::remove_dir_all(home);
        }
    }
}

pub(crate) fn bounded(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}
fn acp_details(tool: &Value, scrub: impl Fn(&str) -> String) -> String {
    let mut parts = Vec::new();
    for part in tool["content"].as_array().into_iter().flatten().take(16) {
        match part["type"].as_str() {
            Some("content") if part["content"]["type"] == "text" => {
                if let Some(text) = part["content"]["text"].as_str() {
                    parts.push(bounded(&scrub(text), 2000));
                }
            }
            Some("diff") => parts.push(format!(
                "{}\nBefore:\n{}\nAfter:\n{}",
                bounded(
                    &scrub(part["path"].as_str().unwrap_or("Proposed edit")),
                    512
                ),
                bounded(&scrub(part["oldText"].as_str().unwrap_or("")), 700),
                bounded(&scrub(part["newText"].as_str().unwrap_or("")), 1200)
            )),
            _ => {}
        }
    }
    bounded(&parts.join("\n"), 2000)
}
// Codex's protocol defines these decisions. Amendments are shown only when the
// actual callback supplied the exact amendment; its order and payload are kept.
fn codex_approval_options(params: &Value) -> Vec<(String, (String, Value))> {
    let mut options = vec![
        (
            "accept".into(),
            ("Allow once".into(), json!({"decision":"accept"})),
        ),
        (
            "acceptForSession".into(),
            (
                "Allow for this session".into(),
                json!({"decision":"acceptForSession"}),
            ),
        ),
    ];
    if let Some(amendment) = params["proposedExecpolicyAmendment"].as_array()
        && !amendment.is_empty()
        && amendment.len() <= 64
        && amendment.iter().all(Value::is_string)
    {
        options.push(("execpolicy".into(), (format!("Allow commands starting with {}", amendment.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")), json!({"decision":{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":amendment}}}))));
    }
    for (i, rule) in params["proposedNetworkPolicyAmendments"]
        .as_array()
        .into_iter()
        .flatten()
        .take(8)
        .enumerate()
    {
        if let (Some(action @ ("allow" | "deny")), Some(host)) =
            (rule["action"].as_str(), rule["host"].as_str())
        {
            options.push((format!("network-{i}"), (format!("{} {host} for future requests", if action == "allow" {"Allow"} else {"Deny"}), json!({"decision":{"applyNetworkPolicyAmendment":{"network_policy_amendment":rule}}}))));
        }
    }
    options.push((
        "decline".into(),
        ("Decline".into(), json!({"decision":"decline"})),
    ));
    options.push((
        "cancel".into(),
        ("Stop this turn".into(), json!({"decision":"cancel"})),
    ));
    options
}

impl Rpc {
    pub async fn spawn(
        program: &Path,
        provider: AgentProvider,
        root: &Path,
        secret: &str,
    ) -> Result<Arc<Self>, String> {
        let launch = if provider == AgentProvider::Deepseek {
            Some(crate::deepseek::prepare()?)
        } else {
            None
        };
        let mut command = if let Some(launch) = &launch {
            let mut command = Command::new(&launch.program);
            command.args(&launch.args).env(&launch.env.0, &launch.env.1);
            command
        } else {
            let mut command = Command::new(program);
            command.arg(if provider == AgentProvider::Codex {
                "app-server"
            } else {
                "acp"
            });
            command
        };
        let owner_marker = uuid::Uuid::new_v4().to_string();
        command
            .env("RHO_AGENT_TASK_OWNER", &owner_marker)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if provider == AgentProvider::Codex {
            command.env("RHO_AGENT_MCP_TOKEN", secret);
        }
        let mut child = command.spawn().map_err(|e| {
            if let Some(launch) = &launch {
                let _ = std::fs::remove_dir_all(&launch.owned_home);
            }
            format!("Cannot start Agent: {e}")
        })?;
        let writer = child.stdin.take().ok_or("Agent stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Agent stdout unavailable")?;
        let mut stderr = child.stderr.take().ok_or("Agent stderr unavailable")?;
        // Native diagnostics stay with the native client. Drain without retaining
        // arbitrary configuration/credential text in the Workbench transcript.
        tokio::spawn(async move {
            let mut bytes = [0u8; 4096];
            while matches!(stderr.read(&mut bytes).await, Ok(n) if n > 0) {}
        });
        let rpc = Arc::new(Self {
            provider,
            writer: AsyncMutex::new(Some(writer)),
            child: AsyncMutex::new(Some(child)),
            replies: Arc::default(),
            decisions: Arc::default(),
            tool_calls: Mutex::new(Vec::new()),
            assistant_boundary: AtomicBool::new(false),
            acp_config: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            buffer: Arc::new(Mutex::new(Buffer {
                session: None,
                started: None,
                turn: None,
                requests: HashMap::new(),
            })),
            secret: secret.to_owned(),
            owned_home: launch.map(|launch| launch.owned_home),
            observer: Mutex::new(crate::observation::Observer::default()),
            capabilities: Mutex::new(rho_agent_api::AgentNativeCapabilities::default()),
            changes: tokio::sync::Notify::new(),
            owner_marker,
        });
        let weak = Arc::downgrade(&rpc);
        tokio::spawn(async move {
            let mut lines = FramedRead::new(stdout, LinesCodec::new_with_max_length(MAX_FRAME));
            let mut error = "Agent transport closed";
            while let Some(line) = lines.next().await {
                let Ok(line) = line else {
                    error = "Agent protocol frame exceeded its limit or could not be read";
                    break;
                };
                let Some(rpc) = weak.upgrade() else {
                    break;
                };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    error = "Agent sent invalid protocol data";
                    break;
                };
                if value.get("method").is_some() {
                    if value.get("id").is_some() {
                        rpc.server_request(value).await;
                    } else {
                        rpc.notification(value);
                    }
                } else if let Some(id) = value["id"].as_u64() {
                    let pending = rpc.replies.lock().unwrap().remove(&id);
                    if let Some(reply) = pending {
                        let result = if let Some(error) = value.get("error") {
                            Err(rpc.scrub(&error.to_string()))
                        } else {
                            Ok(value["result"].clone())
                        };
                        if reply.method == "turn/start" {
                            if let Ok(value) = &result {
                                let mut observer = rpc.observer.lock().unwrap();
                                if observer.session == reply.session && observer.active {
                                    observer.turn = value["turn"]["id"].as_str().map(str::to_owned);
                                }
                            }
                            rpc.changes.notify_waiters();
                        } else if reply.method == "session/prompt" {
                            let mut observer = rpc.observer.lock().unwrap();
                            if observer.session == reply.session && observer.request == reply.request {
                                if let Ok(value) = &result { observer.observe_usage("acp.prompt_response", "turn_total", &value["usage"]); }
                                observer.finish();
                            }
                        }
                        let _ = reply.sender.send(result);
                    }
                }
            }
            if let Some(rpc) = weak.upgrade() {
                rpc.transport_closed(error);
                for (_, reply) in rpc.replies.lock().unwrap().drain() {
                    let _ = reply.sender.send(Err(error.into()));
                }
                rpc.close().await;
            }
        });
        Ok(rpc)
    }
    pub fn scrub(&self, text: &str) -> String {
        bounded(
            &if self.secret.is_empty() {
                text.to_owned()
            } else {
                text.replace(&self.secret, "<private-token>")
            },
            MAX_TEXT,
        )
    }
    async fn send(&self, value: Value) -> Result<(), String> {
        if self.is_closed() {
            return Err("Agent is disconnected".into());
        }
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "Cannot encode Agent request")?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("Agent request is too large".into());
        }
        bytes.push(b'\n');
        let mut writer = self.writer.lock().await;
        writer
            .as_mut()
            .ok_or("Agent is disconnected")?
            .write_all(&bytes)
            .await
            .map_err(|_| "Cannot write to Agent".into())
    }
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }
    pub async fn call(&self, method: &str, params: Value, seconds: u64) -> Result<Value, String> {
        let ticket = self.begin_call(method, params).await?;
        self.finish_call(ticket, seconds).await
    }
    pub async fn begin_call(&self, method: &str, params: Value) -> Result<CallTicket, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let session = params["threadId"]
            .as_str()
            .or_else(|| params["sessionId"].as_str())
            .map(str::to_owned);
        let request = self.observer.lock().unwrap().request.clone();
        self.replies.lock().unwrap().insert(
            id,
            PendingReply {
                sender: tx,
                method: method.into(),
                session,
                request,
            },
        );
        if let Err(error) = self
            .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await
        {
            self.replies.lock().unwrap().remove(&id);
            return Err(error);
        }
        Ok(CallTicket {
            id,
            method: method.into(),
            receiver: rx,
        })
    }
    pub async fn finish_call(&self, ticket: CallTicket, seconds: u64) -> Result<Value, String> {
        let result = tokio::time::timeout(Duration::from_secs(seconds), ticket.receiver).await;
        self.replies.lock().unwrap().remove(&ticket.id);
        match result {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => Err("Agent transport closed".into()),
            Err(_) => Err(format!(
                "Agent {} timed out; the native outcome may still be pending",
                ticket.method
            )),
        }
    }
    /// ACP's prompt response is the end of a turn, not an acknowledgement.
    /// A turn may include long inference, tools and human permission waits.
    /// Keep its correlation until the native reply or transport closure; Stop
    /// remains available through the independent cancellation notification.
    pub async fn finish_prompt(&self, ticket: CallTicket) -> Result<Value, String> {
        let result = ticket.receiver.await;
        self.replies.lock().unwrap().remove(&ticket.id);
        result.unwrap_or_else(|_| Err("Agent transport closed".into()))
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    fn transport_closed(&self, error: &str) {
        self.observer.lock().unwrap().finish();
        self.closed.store(true, Ordering::Release);
        let mut b = self.buffer.lock().unwrap();
        if let Some(s) = &mut b.session
            && s.state != "disconnected"
        {
            s.state = "disconnected".into();
            s.error = Some(self.scrub(error));
            s.decisions.clear();
        }
        self.decisions.lock().unwrap().clear();
        self.tool_calls.lock().unwrap().clear();
        self.changes.notify_waiters();
    }
    pub fn complete(&self, error: Option<String>, interrupted: bool) {
        self.observer.lock().unwrap().finish();
        let mut b = self.buffer.lock().unwrap();
        let elapsed = b.started.take().map(|t| t.elapsed().as_millis() as u64);
        if let Some(s) = &mut b.session {
            s.state = if self.is_closed() {
                "disconnected"
            } else if error.as_ref().is_some_and(|e| {
                e.contains("timed out") || e.starts_with("Submission outcome is uncertain;")
            }) {
                "uncertain"
            } else if error.is_some() {
                "failed"
            } else if interrupted {
                "interrupted"
            } else {
                "ready"
            }
            .into();
            if error.is_some() || !self.is_closed() {
                s.error = error.map(|e| self.scrub(&e));
            }
            s.elapsed_ms = elapsed;
            s.decisions.clear();
        }
        self.decisions.lock().unwrap().clear();
        self.changes.notify_waiters();
    }
    pub async fn process_id(&self) -> Option<u32> {
        self.child.lock().await.as_ref().and_then(|p| p.id())
    }
    fn notification(&self, value: Value) {
        let method = value["method"].as_str().unwrap_or("");
        let p = &value["params"];
        if !self.observer.lock().unwrap().accepts(self.provider, p) {
            return;
        }
        self.observer
            .lock()
            .unwrap()
            .observe(self.provider, method, p, |s| self.scrub(s));
        if method == "session/update" && p["update"]["sessionUpdate"] == "current_mode_update" {
            if let Some(mode) = p["update"]["currentModeId"].as_str() {
                let mut caps = self.capabilities.lock().unwrap();
                if caps.modes.iter().any(|m| m.id == mode) {
                    caps.current_mode = Some(mode.to_owned());
                }
            }
            self.changes.notify_waiters();
            return;
        }
        if method == "session/update" && p["update"]["sessionUpdate"] == "config_option_update" {
            if let Some(id) = p["sessionId"].as_str() {
                let options = &p["update"]["configOptions"];
                if options.is_array() && options.to_string().len() <= 1024 * 1024 {
                    let mut config = self.acp_config.lock().unwrap();
                    if config.len() < 4 || config.contains_key(id) {
                        config.insert(id.to_owned(), options.clone());
                        let models =
                            crate::acp_models(&json!({"configOptions":options}), self.provider).0;
                        if !models.is_empty() {
                            self.capabilities.lock().unwrap().models = models;
                        }
                    }
                }
            }
            return;
        }
        if self.provider == AgentProvider::Codex && method == "turn/started" {
            self.buffer.lock().unwrap().turn = p["turn"]["id"].as_str().map(str::to_owned);
        }
        if self.provider == AgentProvider::Codex && method == "turn/completed" {
            let status = p["turn"]["status"].as_str().unwrap_or("");
            self.complete(
                (status == "failed").then(|| p["turn"]["error"].to_string()),
                status == "interrupted",
            );
            return;
        }
        let mut b = self.buffer.lock().unwrap();
        let Some(s) = &mut b.session else {
            return;
        };
        let mut text = None;
        let mut activity = None;
        match (self.provider, method) {
            (AgentProvider::Codex, "item/agentMessage/delta") => text = p["delta"].as_str(),
            (AgentProvider::Codex, "item/started" | "item/completed") => {
                let item = &p["item"];
                if item["type"] != "agentMessage"
                    && item["type"] != "userMessage"
                    && item["type"] != "reasoning"
                {
                    activity = Some(format!(
                        "{} · {}",
                        item["type"].as_str().unwrap_or("Agent activity"),
                        if method.ends_with("completed") {
                            "completed"
                        } else {
                            "running"
                        }
                    ));
                }
            }
            (AgentProvider::Kimi | AgentProvider::Deepseek, "session/update") => {
                let update = &p["update"];
                match update["sessionUpdate"].as_str().unwrap_or("") {
                    "agent_message_chunk" => text = update["content"]["text"].as_str(),
                    "tool_call" | "tool_call_update" => {
                        if let Some(id) = update["toolCallId"].as_str() {
                            let mut calls = self.tool_calls.lock().unwrap();
                            let old = calls.iter().find(|(key, _, _)| key == id).cloned();
                            let title = update["title"]
                                .as_str()
                                .map(|v| self.scrub(v))
                                .or_else(|| old.as_ref().map(|v| v.1.clone()))
                                .unwrap_or_default();
                            let details = if update.get("rawInput").is_some() {
                                bounded(&self.scrub(&update["rawInput"].to_string()), 2000)
                            } else {
                                let content = acp_details(update, |text| self.scrub(text));
                                if content.is_empty() {
                                    old.map(|v| v.2).unwrap_or_default()
                                } else {
                                    self.scrub(&content)
                                }
                            };
                            calls.retain(|(key, _, _)| key != id);
                            if calls.len() >= 32 {
                                calls.remove(0);
                            }
                            calls.push((id.to_owned(), title, details));
                        }
                        activity = Some(format!(
                            "{} · {}",
                            update["title"].as_str().unwrap_or("Tool"),
                            update["status"].as_str().unwrap_or("running")
                        ))
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if let Some(text) = text {
            if self.assistant_boundary.swap(false, Ordering::Relaxed)
                || s.messages.last().is_none_or(|m| m.role != "assistant")
            {
                while s.messages.len() >= 40 {
                    s.messages.drain(..2);
                    s.truncated = true;
                }
                s.messages.push(AgentMessage {
                    role: "assistant".into(),
                    text: String::new(),
                });
            }
            while s.messages.len() > 2
                && s.messages.iter().map(|m| m.text.len()).sum::<usize>() + text.len() > MAX_TEXT
            {
                s.messages.drain(..2);
                s.truncated = true;
            }
            let remaining =
                MAX_TEXT.saturating_sub(s.messages.iter().map(|m| m.text.len()).sum::<usize>());
            let last = s.messages.last_mut().unwrap();
            let text = self.scrub(text);
            if text.len() > remaining {
                s.truncated = true;
            }
            last.text.push_str(&bounded(&text, remaining));
        }
        if let Some(activity) = activity {
            // Native tool activity separates a progress utterance from the
            // subsequent assistant response; neither text segment is discarded.
            self.assistant_boundary.store(true, Ordering::Relaxed);
            if s.activity.len() == 20 {
                s.activity.remove(0);
            }
            s.activity.push(bounded(&self.scrub(&activity), 500));
        }
    }
    async fn server_request(&self, value: Value) {
        let method = value["method"].as_str().unwrap_or("");
        let params = &value["params"];
        let allowed = {
            let observer = self.observer.lock().unwrap();
            observer.accepts(self.provider, params)
                && (observer.session.is_none() || observer.active)
        };
        if !allowed {
            let _ = self.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32602,"message":"Stale native session or turn"}})).await;
            return;
        }
        let mut options = Vec::new();
        let title;
        let mut details = String::new();
        if method == "session/request_permission" {
            let observed = params["toolCall"]["toolCallId"].as_str().and_then(|id| {
                self.tool_calls
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(key, _, _)| key == id)
                    .cloned()
            });
            title = params["toolCall"]["title"]
                .as_str()
                .or_else(|| {
                    observed
                        .as_ref()
                        .map(|call| call.1.as_str())
                        .filter(|title| !title.is_empty())
                })
                .unwrap_or("Agent requests permission")
                .to_owned();
            details = acp_details(&params["toolCall"], |text| self.scrub(text));
            if let Some(observed) = observed.filter(|call| !call.2.is_empty() && call.2 != details)
            {
                if !details.is_empty() {
                    details.push('\n');
                }
                details.push_str(&observed.2);
            }
            let native_options = params["options"].as_array();
            let valid = native_options.is_some_and(|options| {
                !options.is_empty()
                    && options.len() <= 64
                    && options.iter().all(|o| {
                        o["optionId"]
                            .as_str()
                            .is_some_and(|id| !id.is_empty() && id.len() <= 512)
                    })
                    && options
                        .iter()
                        .filter_map(|o| o["optionId"].as_str())
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == options.len()
            });
            if !valid {
                let _ = self.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32602,"message":"Native permission choices are invalid or exceed the 64-choice budget"}})).await;
                return;
            }
            for option in native_options.into_iter().flatten() {
                if let Some(id) = option["optionId"].as_str() {
                    options.push((
                        id.to_owned(),
                        (
                            option["name"].as_str().unwrap_or(id).to_owned(),
                            json!({"outcome":{"outcome":"selected","optionId":id}}),
                        ),
                    ));
                }
            }
        } else if matches!(
            method,
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
        ) {
            title = params["reason"]
                .as_str()
                .unwrap_or("Codex requests permission")
                .to_owned();
            options = codex_approval_options(params);
            if let Some(root) = params["grantRoot"].as_str() {
                details = format!("Write access: {root}");
            }
        } else if method == "item/permissions/requestApproval" && params["permissions"].is_object()
        {
            title = params["reason"]
                .as_str()
                .unwrap_or("Codex requests access")
                .to_owned();
            details = params["permissions"].to_string();
            for (id, label, scope) in [
                ("turn", "Allow for this turn", "turn"),
                ("session", "Allow for this session", "session"),
            ] {
                options.push((
                    id.into(),
                    (
                        label.into(),
                        json!({"permissions":params["permissions"],"scope":scope}),
                    ),
                ));
            }
            options.push((
                "decline".into(),
                ("Decline".into(), json!({"permissions":{},"scope":"turn"})),
            ));
        } else {
            let _ = self.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"This client does not support the requested interaction"}})).await;
            return;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let decision = AgentDecision {
            id,
            title: self.scrub(&title),
            details: bounded(
                &self.scrub(params["command"].as_str().unwrap_or(&details)),
                2000,
            ),
            options: options
                .iter()
                .map(|(id, (label, _))| AgentDecisionOption {
                    id: id.clone(),
                    label: bounded(&self.scrub(label), 500),
                })
                .collect(),
        };
        let accepted = {
            let mut b = self.buffer.lock().unwrap();
            if let Some(s) = &mut b.session
                && s.decisions.len() < 8
            {
                s.decisions.push(decision);
                s.state = "waiting_for_permission".into();
                true
            } else {
                false
            }
        };
        if accepted {
            self.decisions.lock().unwrap().insert(
                id,
                (
                    value["id"].clone(),
                    options
                        .into_iter()
                        .map(|(id, (_, reply))| (id, reply))
                        .collect(),
                ),
            );
        } else {
            let _ = self.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32603,"message":"No active Agent session"}})).await;
        }
    }
    pub async fn decide(&self, id: u64, option: &str) -> Result<(), String> {
        let (native, reply) = {
            let mut pending = self.decisions.lock().unwrap();
            let (native, options) = pending.get(&id).ok_or("Permission request expired")?;
            let reply = options
                .get(option)
                .ok_or("Unknown permission decision")?
                .clone();
            let native = native.clone();
            pending.remove(&id);
            (native, reply)
        };
        self.send(json!({"jsonrpc":"2.0","id":native,"result":reply}))
            .await?;
        if let Some(s) = &mut self.buffer.lock().unwrap().session {
            s.decisions.retain(|d| d.id != id);
            if s.decisions.is_empty() {
                s.state = "running".into();
            }
        }
        Ok(())
    }
    pub async fn initial_acp_options(&self, session: &str, initial: Value) -> Value {
        // DeepSeek mounts settings-backed providers asynchronously and reports
        // the corrected catalog through standard ACP configuration updates.
        // Collect that startup burst within a fixed, sub-second read budget.
        tokio::time::sleep(Duration::from_millis(750)).await;
        self.acp_config
            .lock()
            .unwrap()
            .remove(session)
            .unwrap_or(initial)
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(s) = &mut self.buffer.lock().unwrap().session {
            s.state = "disconnected".into();
            s.decisions.clear();
        }
        self.decisions.lock().unwrap().clear();
        self.writer.lock().await.take();
        if let Some(mut child) = self.child.lock().await.take()
            && tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let Some(home) = &self.owned_home {
            let _ = std::fs::remove_dir_all(home);
        }
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    #[test]
    fn permission_excerpts_redact_before_truncating_a_credential() {
        let secret = "#test-secret-that-crosses-the-excerpt-boundary";
        let tool = json!({"content":[{"type":"content","content":{"type":"text","text":format!("{}{secret}", "x".repeat(1990))}}]});
        let details = acp_details(&tool, |text| text.replace(secret, "<private-token>"));
        assert!(details.len() <= 2000);
        assert!(!details.contains("#test"));
    }
    #[test]
    fn codex_amendments_keep_native_payloads_and_basic_choices() {
        let native = json!({"proposedExecpolicyAmendment":["git","status"],"proposedNetworkPolicyAmendments":[{"action":"deny","host":"example.test"}]});
        let options = codex_approval_options(&native);
        assert_eq!(
            options.iter().map(|o| o.0.as_str()).collect::<Vec<_>>(),
            vec![
                "accept",
                "acceptForSession",
                "execpolicy",
                "network-0",
                "decline",
                "cancel"
            ]
        );
        assert_eq!(
            options[2].1.1["decision"]["acceptWithExecpolicyAmendment"]["execpolicy_amendment"],
            native["proposedExecpolicyAmendment"]
        );
        assert_eq!(codex_approval_options(&json!({})).len(), 4);
    }
}
