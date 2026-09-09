//! Uniform native-session boundary used by the Host task service and fake adapters.
use super::*;
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_contract::{AgentNativeCapabilities, AgentPermissionMode};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, ffi::OsStr};
use sysinfo::{
    Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, Signal, System, UpdateKind,
};

#[derive(Debug, Clone)]
pub struct NativeProcessProof {
    pub pid: u32,
    pub start_time: u64,
    pub executable: String,
    pub marker: String,
}
pub struct NativeOpenRequest {
    pub provider: AgentProvider,
    pub root: PathBuf,
    pub window: ApplicationWindowRef,
    pub native_session_id: Option<String>,
    pub endpoint: String,
    pub token: String,
    pub interrupted: bool,
}
#[derive(Clone)]
pub enum NativeInput {
    Text(String),
    Image {
        mime_type: String,
        data: Vec<u8>,
    },
    Resource {
        uri: String,
        text: String,
        mime_type: String,
    },
}
pub struct NativePrompt {
    pub request_id: String,
    pub display_text: String,
    pub parts: Vec<NativeInput>,
    pub window: ApplicationWindowRef,
}
#[async_trait]
pub trait NativeAgentSession: Send + Sync {
    fn snapshot(&self) -> AgentClientSession;
    fn capabilities(&self) -> AgentNativeCapabilities;
    fn events(&self, after: u64) -> NativeEventPage;
    fn native_turn_id(&self) -> Option<String>;
    fn process_proof(&self) -> Option<NativeProcessProof>;
    async fn configure(
        &self,
        model: &str,
        effort: Option<&str>,
        mode: Option<&str>,
    ) -> Result<(), String>;
    async fn send(&self, input: NativePrompt) -> Result<(), String>;
    async fn interrupt(&self) -> Result<(), String>;
    async fn decide(&self, id: u64, option: &str) -> Result<(), String>;
    async fn close(&self);
    async fn changed(&self);
    fn rebind(&self, window: ApplicationWindowRef);
    async fn history(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<(Vec<NativeEvent>, Option<String>), String>;
}
#[async_trait]
pub trait NativeAgentFactory: Send + Sync {
    async fn open(
        &self,
        request: NativeOpenRequest,
    ) -> Result<Arc<dyn NativeAgentSession>, NativeOpenFailure>;
    async fn recover_process(&self, proof: &NativeProcessProof) -> Result<(), String>;
}
pub struct LocalNativeAgents;
#[derive(Debug, Clone)]
pub struct NativeOpenFailure {
    pub error: String,
    pub uncertain: bool,
    pub native_session_id: Option<String>,
}
impl From<String> for NativeOpenFailure {
    fn from(error: String) -> Self {
        Self {
            error,
            uncertain: false,
            native_session_id: None,
        }
    }
}
impl From<&str> for NativeOpenFailure {
    fn from(error: &str) -> Self {
        error.to_owned().into()
    }
}
struct Connection {
    client: Arc<ExternalAgentClient>,
    proof: Option<NativeProcessProof>,
}

pub(crate) fn capabilities(
    provider: AgentProvider,
    init: &Value,
    session: &Value,
) -> AgentNativeCapabilities {
    let mut caps = AgentNativeCapabilities {
        resume: provider == AgentProvider::Codex
            || init["agentCapabilities"]["loadSession"] == true
            || init["agentCapabilities"]["sessionCapabilities"]
                .get("resume")
                .is_some_and(Value::is_object),
        history: match provider {
            AgentProvider::Codex => "native_history",
            AgentProvider::Kimi => "native_context_history",
            AgentProvider::Deepseek => "observation_cache",
        }
        .into(),
        images: provider == AgentProvider::Codex
            || init["agentCapabilities"]["promptCapabilities"]["image"] == true,
        embedded_context: provider == AgentProvider::Codex
            || init["agentCapabilities"]["promptCapabilities"]["embeddedContext"] == true,
        ..Default::default()
    };
    let modes = session["modes"]["availableModes"].as_array();
    caps.modes = modes
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|m| {
            Some(AgentPermissionMode {
                id: bounded(m["id"].as_str()?, 128),
                name: bounded(m["name"].as_str()?, 128),
                description: m["description"].as_str().map(|s| bounded(s, 512)),
            })
        })
        .collect();
    caps.current_mode = session["modes"]["currentModeId"]
        .as_str()
        .map(str::to_owned);
    if provider != AgentProvider::Codex {
        caps.models = acp_models(session, provider).0;
    }
    caps
}

/// Exact Rho-created Kimi session metadata only. No native session enumeration,
/// imports or historical-format readers. Kimi ACP 0.41 ignores cwd on load.
fn verify_kimi_project(root: &Path, id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Invalid saved Kimi session identity".into());
    }
    let normalized = root.to_string_lossy().replace('\\', "/");
    let normalized = if normalized == "/" || (normalized.len() == 3 && normalized.ends_with(":/")) {
        normalized
    } else {
        normalized.trim_end_matches('/').to_owned()
    };
    let mut slug = String::new();
    let mut separator = false;
    for c in normalized
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .chars()
    {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            separator = false;
        } else if !separator {
            slug.push('-');
            separator = true;
        }
    }
    slug = slug
        .trim_matches('-')
        .chars()
        .take(40)
        .collect::<String>()
        .trim_matches('-')
        .into();
    if matches!(slug.as_str(), "" | "." | "..") {
        slug = "workspace".into();
    }
    let hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    let home = std::env::var_os("KIMI_CODE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".kimi-code"))
        })
        .ok_or("Kimi home unavailable")?;
    let path = kimi_state_path(&home, root, &format!("wd_{slug}_{}", &hash[..12]), id)?;
    let actual = path.canonicalize().map_err(
        |_| "Saved Kimi session project metadata is unavailable; no replacement was created",
    )?;
    let base = home.canonicalize().map_err(|_| "Kimi home unavailable")?;
    if !actual.starts_with(&base) {
        return Err("Kimi session metadata escaped its native home".into());
    }
    let metadata = std::fs::metadata(&actual).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 512 * 1024 {
        return Err("Kimi session metadata exceeds its read budget".into());
    }
    let data: Value = serde_json::from_slice(&std::fs::read(actual).map_err(|e| e.to_string())?)
        .map_err(|_| "Kimi session metadata is invalid")?;
    if data["version"] != 2 || data["id"] != id || data["cwd"] != root.to_string_lossy().as_ref() {
        return Err(
            "Saved Kimi session belongs to a different project or unsupported metadata version"
                .into(),
        );
    }
    Ok(())
}

fn kimi_state_path(home: &Path, root: &Path, derived: &str, id: &str) -> Result<PathBuf, String> {
    let direct = home
        .join("sessions")
        .join(derived)
        .join(id)
        .join("state.json");
    if direct.is_file() {
        return Ok(direct);
    }
    // A named native workspace may use an alias. Read only the bounded workspace
    // registry and this known session ID, never enumerate native sessions.
    let registry = home.join("workspaces.json");
    if let Ok(metadata) = std::fs::metadata(&registry) {
        let base = home.canonicalize().map_err(|_| "Kimi home unavailable")?;
        if !metadata.is_file()
            || metadata.len() > 1024 * 1024
            || !registry
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(base)
        {
            return Err("Kimi workspace registry exceeds its read scope or budget".into());
        }
        let value: Value =
            serde_json::from_slice(&std::fs::read(registry).map_err(|e| e.to_string())?)
                .map_err(|_| "Kimi workspace registry is invalid")?;
        if value["version"] == 1 {
            for (key, _) in value["workspaces"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, w)| w["root"] == root.to_string_lossy().as_ref())
                .take(32)
            {
                if key.is_empty()
                    || key.len() > 160
                    || matches!(key.as_str(), "." | "..")
                    || !key
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                {
                    continue;
                }
                let path = home.join("sessions").join(key).join(id).join("state.json");
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }
    Err("Saved Kimi session project metadata is unavailable; no replacement was created".into())
}

#[async_trait]
impl NativeAgentFactory for LocalNativeAgents {
    async fn open(
        &self,
        r: NativeOpenRequest,
    ) -> Result<Arc<dyn NativeAgentSession>, NativeOpenFailure> {
        let program = executable(r.provider).ok_or("Native Agent CLI is not installed")?;
        if r.provider == AgentProvider::Kimi
            && let Some(id) = &r.native_session_id
        {
            verify_kimi_project(&r.root, id)?;
        }
        let rpc = Rpc::spawn(&program, r.provider, &r.root, &r.token).await?;
        let init = match initialize(&rpc, r.provider).await {
            Ok(v) => v,
            Err(e) => {
                rpc.close().await;
                return Err(e.into());
            }
        };
        let mcp = json!([{"type":"http","name":"rho","url":r.endpoint,"headers":[{"name":"Authorization","value":format!("Bearer {}",r.token)}]}]);
        let mut prior_caps = capabilities(r.provider, &init, &Value::Null);
        if r.provider == AgentProvider::Deepseek {
            prior_caps.resume = init["agentCapabilities"]["sessionCapabilities"]
                .get("resume")
                .is_some_and(Value::is_object);
        }
        if r.native_session_id.is_some() && !prior_caps.resume {
            rpc.close().await;
            return Err("This native Agent does not advertise session recovery".into());
        }
        if let Some(id) = &r.native_session_id {
            rpc.observer
                .lock()
                .unwrap()
                .bind(id, r.provider == AgentProvider::Kimi);
        }
        let call=async {
            if r.provider==AgentProvider::Codex {
                let mut p=json!({"cwd":r.root,"ephemeral":false,"config":{"mcp_servers":{"rho":{"url":r.endpoint,"bearer_token_env_var":"RHO_AGENT_MCP_TOKEN","default_tools_approval_mode":"approve","startup_timeout_sec":15,"tool_timeout_sec":90}}}});
                let method=if let Some(id)=&r.native_session_id {p["threadId"]=json!(id);"thread/resume"} else {"thread/start"};
                rpc.call(method,p,30).await
            } else {
                open_acp_session(&rpc, r.provider, r.native_session_id.as_deref(), &r.root, &mcp, r.interrupted).await
            }
        }.await;
        let data = match call {
            Ok(v) => v,
            Err(e) => {
                rpc.close().await;
                return Err(NativeOpenFailure {
                    error: e,
                    uncertain: true,
                    native_session_id: r.native_session_id.clone(),
                });
            }
        };
        let native = if r.provider == AgentProvider::Codex {
            if data["thread"]["cwd"] != r.root.to_string_lossy().as_ref() {
                rpc.close().await;
                return Err(NativeOpenFailure {
                    error: "Native Codex thread belongs to another project".into(),
                    uncertain: true,
                    native_session_id: None,
                });
            }
            data["thread"]["id"].as_str().map(str::to_owned)
        } else {
            data["sessionId"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| r.native_session_id.clone())
        }
        .ok_or_else(|| NativeOpenFailure {
            error: "Native Agent did not confirm a session identity".into(),
            uncertain: true,
            native_session_id: None,
        })?;
        if r.native_session_id
            .as_ref()
            .is_some_and(|expected| expected != &native)
        {
            rpc.close().await;
            return Err("Native Agent returned a different session identity".into());
        }
        if r.provider == AgentProvider::Codex
            && r.native_session_id.is_some()
            && let Err(error) = ensure_codex_quiet(&rpc, &native, &data["thread"]).await
        {
            rpc.close().await;
            return Err(NativeOpenFailure {
                error,
                uncertain: true,
                native_session_id: Some(native),
            });
        }
        if r.native_session_id.is_none() {
            rpc.observer.lock().unwrap().bind(&native, false);
        } else {
            rpc.observer.lock().unwrap().replaying = false;
        }
        let mut caps = capabilities(r.provider, &init, &data);
        caps.resume = prior_caps.resume;
        if r.provider == AgentProvider::Codex {
            caps.models = codex_models(&rpc)
                .await
                .map_err(|error| NativeOpenFailure {
                    error,
                    uncertain: false,
                    native_session_id: Some(native.clone()),
                })?;
        }
        if r.provider == AgentProvider::Deepseek {
            let options = rpc
                .initial_acp_options(&native, data["configOptions"].clone())
                .await;
            caps.models = acp_models(&json!({"configOptions":options}), r.provider).0;
        }
        let (_, selected, effort) = acp_models(&data, r.provider);
        *rpc.capabilities.lock().unwrap() = caps;
        rpc.buffer.lock().unwrap().session = Some(AgentClientSession {
            id: uuid::Uuid::new_v4().to_string(),
            provider: r.provider,
            native_session_id: native,
            project_root: r.root.to_string_lossy().into_owned(),
            window: r.window,
            model: selected.unwrap_or_default(),
            effort,
            state: "ready".into(),
            messages: vec![],
            activity: vec![],
            decisions: vec![],
            error: None,
            truncated: false,
            elapsed_ms: None,
            last_request_id: None,
        });
        let proof = rpc
            .process_id()
            .await
            .and_then(|pid| capture_process(pid, &rpc.owner_marker));
        Ok(Arc::new(Connection {
            client: Arc::new(ExternalAgentClient {
                rpc,
                provider: r.provider,
            }),
            proof,
        }))
    }
    async fn recover_process(&self, proof: &NativeProcessProof) -> Result<(), String> {
        stop_owned_process(proof).await
    }
}

#[async_trait]
impl NativeAgentSession for Connection {
    fn snapshot(&self) -> AgentClientSession {
        self.client.snapshot()
    }
    fn capabilities(&self) -> AgentNativeCapabilities {
        self.client.rpc.capabilities.lock().unwrap().clone()
    }
    fn events(&self, after: u64) -> NativeEventPage {
        self.client.rpc.observer.lock().unwrap().page(after)
    }
    fn native_turn_id(&self) -> Option<String> {
        self.client.rpc.observer.lock().unwrap().turn.clone()
    }
    fn process_proof(&self) -> Option<NativeProcessProof> {
        self.proof.clone()
    }
    fn rebind(&self, window: ApplicationWindowRef) {
        if let Some(s) = &mut self.client.rpc.buffer.lock().unwrap().session {
            s.window = window;
        }
    }
    async fn configure(
        &self,
        model: &str,
        effort: Option<&str>,
        mode: Option<&str>,
    ) -> Result<(), String> {
        let snapshot = self.snapshot();
        let rpc = &self.client.rpc;
        if model.is_empty() || !self.capabilities().models.iter().any(|m| m.id == model) {
            return Err("Model is not in this native Agent's catalog".into());
        }
        if self.client.provider != AgentProvider::Codex {
            if snapshot.model != model {
                let result=rpc.call("session/set_config_option",json!({"sessionId":snapshot.native_session_id,"configId":"model","value":model}),15).await?;
                let models = acp_models(&result, self.client.provider).0;
                if !models.is_empty() {
                    rpc.capabilities.lock().unwrap().models = models;
                }
            }
            if let Some(effort) = effort
                && snapshot.effort.as_deref() != Some(effort)
            {
                rpc.call("session/set_config_option",json!({"sessionId":snapshot.native_session_id,"configId":effort_option(self.client.provider),"value":effort}),15).await?;
            }
            if let Some(mode) = mode {
                if !self.capabilities().modes.iter().any(|m| m.id == mode) {
                    return Err("Permission mode is not advertised by this Agent".into());
                }
                if self.capabilities().current_mode.as_deref() != Some(mode) {
                    rpc.call(
                        "session/set_mode",
                        json!({"sessionId":snapshot.native_session_id,"modeId":mode}),
                        15,
                    )
                    .await?;
                    rpc.capabilities.lock().unwrap().current_mode = Some(mode.into());
                }
            }
        } else if mode.is_some() {
            return Err("Codex does not advertise a session permission-mode picker".into());
        }
        if let Some(s) = &mut rpc.buffer.lock().unwrap().session {
            s.model = model.into();
            s.effort = effort.map(str::to_owned);
        }
        Ok(())
    }
    async fn send(&self, input: NativePrompt) -> Result<(), String> {
        let client = self.client.clone();
        let s = client.snapshot();
        if !matches!(s.state.as_str(), "ready" | "interrupted" | "failed") {
            return Err("Native Agent is not idle".into());
        }
        let caps = self.capabilities();
        let codex = client.provider == AgentProvider::Codex;
        let mut parts = Vec::new();
        for part in input.parts {
            parts.push(match part {
                NativeInput::Text(text)=>json!({"type":"text","text":text}),
                NativeInput::Image{mime_type,data}=>{
                    if !caps.images {return Err("This native Agent does not support image input".into());}
                    if codex {json!({"type":"image","url":format!("data:{mime_type};base64,{}",STANDARD.encode(data))})} else {json!({"type":"image","mimeType":mime_type,"data":STANDARD.encode(data)})}
                },
                NativeInput::Resource{uri,text,mime_type}=>{
                    if codex || !caps.embedded_context {json!({"type":"text","text":format!("Attached resource: {uri}\n{text}")})} else {json!({"type":"resource","resource":{"uri":uri,"text":text,"mimeType":mime_type}})}
                }
            });
        }
        let params = if codex {
            json!({"threadId":s.native_session_id,"model":s.model,"effort":s.effort,"input":parts})
        } else {
            json!({"sessionId":s.native_session_id,"prompt":parts})
        };
        if params.to_string().len() > 15 * 1024 * 1024 {
            return Err("Native input exceeds the 15 MiB transport budget".into());
        }
        {
            let mut b = client.rpc.buffer.lock().unwrap();
            let state = b.session.as_mut().ok_or("Native session unavailable")?;
            state.window = input.window;
            state.state = "running".into();
            state.error = None;
            state.decisions.clear();
            state.last_request_id = Some(input.request_id.clone());
            b.started = Some(Instant::now());
            b.turn = None;
        }
        client
            .rpc
            .observer
            .lock()
            .unwrap()
            .begin(&input.request_id, &input.display_text);
        let ticket = match client
            .rpc
            .begin_call(
                if codex {
                    "turn/start"
                } else {
                    "session/prompt"
                },
                params,
            )
            .await
        {
            Ok(ticket) => ticket,
            Err(error) => {
                client.rpc.complete(
                    Some(format!("Submission timed out or was interrupted; {error}")),
                    false,
                );
                return Err(error);
            }
        };
        tokio::spawn(async move {
            let result = client
                .rpc
                .finish_call(ticket, if codex { 30 } else { 600 })
                .await;
            match result {
                Ok(value) if codex => {
                    let turn = value["turn"]["id"].as_str().map(str::to_owned);
                    client.rpc.buffer.lock().unwrap().turn = turn.clone();
                    client.rpc.observer.lock().unwrap().turn = turn;
                }
                Ok(value) => client
                    .rpc
                    .complete(None, value["stopReason"] == "cancelled"),
                Err(error) => client.rpc.complete(
                    Some(format!("Submission outcome is uncertain; {error}")),
                    false,
                ),
            }
        });
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), String> {
        self.client.interrupt().await
    }
    async fn decide(&self, id: u64, option: &str) -> Result<(), String> {
        self.client.decide(id, option).await
    }
    async fn close(&self) {
        self.client.close().await;
    }
    async fn changed(&self) {
        self.client.rpc.changes.notified().await;
    }
    async fn history(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<(Vec<NativeEvent>, Option<String>), String> {
        if self.client.provider != AgentProvider::Codex {
            return Err(
                "This Agent exposes history through its recovery replay or observation cache"
                    .into(),
            );
        }
        if !(1..=50).contains(&limit) || cursor.as_ref().is_some_and(|s| s.len() > 4096) {
            return Err("Invalid native history page".into());
        }
        let session = self.snapshot().native_session_id;
        let data=self.client.rpc.call("thread/turns/list",json!({"threadId":session,"cursor":cursor,"limit":limit,"sortDirection":"desc","itemsView":"full"}),15).await?;
        let next = data["nextCursor"].as_str().map(str::to_owned);
        if next.is_some() && next == cursor {
            return Err("Native history cursor did not advance".into());
        }
        let turns = data["data"]
            .as_array()
            .ok_or("Native history did not return turns")?;
        let mut events = Vec::new();
        let mut bytes = 0;
        for turn in turns.iter().rev() {
            let Some(turn_id) = turn["id"].as_str() else {
                continue;
            };
            for item in turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .take(500 - events.len())
            {
                let Some(item_id) = item["id"].as_str() else {
                    continue;
                };
                let kind = item["type"].as_str().unwrap_or("");
                if kind == "reasoning" {
                    continue;
                }
                let (role, text) = match kind {
                    "agentMessage" => (
                        Some("assistant"),
                        item["text"].as_str().unwrap_or("").to_owned(),
                    ),
                    "userMessage" => (
                        Some("user"),
                        item["content"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|p| p["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
                    _ => (
                        None,
                        item["command"]
                            .as_str()
                            .or_else(|| item["tool"].as_str())
                            .unwrap_or(kind)
                            .to_owned(),
                    ),
                };
                let text = self.client.rpc.scrub(&text);
                let bounded = bounded(
                    &text,
                    (1024 * 1024usize).saturating_sub(bytes).min(256 * 1024),
                );
                bytes += bounded.len();
                events.push(NativeEvent {
                    cursor: 0,
                    key: format!("native:{turn_id}:{item_id}"),
                    request_id: None,
                    session: session.clone(),
                    turn: Some(turn_id.into()),
                    item: Some(item_id.into()),
                    kind: if role.is_some() { "message" } else { "tool" }.into(),
                    role: role.map(str::to_owned),
                    text: bounded.clone(),
                    status: if bounded.len() < text.len() {
                        Some("truncated".into())
                    } else {
                        item["status"].as_str().map(str::to_owned)
                    },
                    historical: true,
                    at_ms: turn["startedAt"].as_u64().unwrap_or(0).saturating_mul(1000),
                });
            }
        }
        Ok((events, next))
    }
}

async fn open_acp_session(
    rpc: &Rpc,
    provider: AgentProvider,
    id: Option<&str>,
    root: &Path,
    mcp: &Value,
    interrupted: bool,
) -> Result<Value, String> {
    if let Some(id) = id {
        let params = json!({"sessionId":id,"cwd":root,"mcpServers":mcp});
        if provider == AgentProvider::Deepseek && interrupted {
            // Native close consumes/cancels persisted Inbox nodes. Merely loading
            // their context leaves them eligible for the next incoming prompt.
            rpc.call("session/resume", params.clone(), 30).await?;
            rpc.call("session/close", json!({"sessionId":id}), 15)
                .await?;
        }
        rpc.call(
            if provider == AgentProvider::Kimi {
                "session/load"
            } else {
                "session/resume"
            },
            params,
            30,
        )
        .await
    } else {
        rpc.call("session/new", json!({"cwd":root,"mcpServers":mcp}), 30)
            .await
    }
}

/// Resume restores context only. A resumed native turn must be quiet before the
/// service can expose a connection that accepts a new submission.
async fn ensure_codex_quiet(rpc: &Rpc, id: &str, thread: &Value) -> Result<(), String> {
    match thread["status"]["type"].as_str() {
        Some("idle") => return Ok(()),
        Some("active") => {}
        _ => return Err("Codex did not confirm an idle restored thread".into()),
    }
    let turn = thread["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|turn| turn["status"] == "inProgress")
        .and_then(|turn| turn["id"].as_str())
        .ok_or("Codex restored active work without a confirmed turn identity")?;
    rpc.call("turn/interrupt", json!({"threadId":id,"turnId":turn}), 10)
        .await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = rpc
            .call(
                "thread/read",
                json!({"threadId":id,"includeTurns":false}),
                5,
            )
            .await?;
        if result["thread"]["id"] != id {
            return Err("Codex returned a different restored thread".into());
        }
        if result["thread"]["status"]["type"] == "idle" {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Codex has not confirmed that restored work stopped".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn process_refresh() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .without_tasks()
        .with_environ(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .with_user(UpdateKind::Always)
}
fn capture_process(pid: u32, marker: &str) -> Option<NativeProcessProof> {
    let mut s = System::new();
    s.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        process_refresh(),
    );
    let p = s.process(Pid::from_u32(pid))?;
    if p.start_time() == 0
        || !p
            .environ()
            .iter()
            .any(|e| e == OsStr::new(&format!("RHO_AGENT_TASK_OWNER={marker}")))
    {
        return None;
    }
    Some(NativeProcessProof {
        pid,
        start_time: p.start_time(),
        executable: p.exe()?.to_string_lossy().into_owned(),
        marker: marker.into(),
    })
}
async fn stop_owned_process(proof: &NativeProcessProof) -> Result<(), String> {
    uuid::Uuid::parse_str(&proof.marker)
        .map_err(|_| "Invalid native process ownership evidence")?;
    if proof.start_time == 0 {
        return Err("Native process start identity is unavailable".into());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut signalled = HashSet::new();
    loop {
        let mut s = System::new();
        s.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh());
        let own = s
            .process(Pid::from_u32(std::process::id()))
            .ok_or("Native process inspection unavailable")?;
        let uid = own.user_id().ok_or("Native user identity unavailable")?;
        let marker = format!("RHO_AGENT_TASK_OWNER={}", proof.marker);
        let mut matching = 0;
        for p in s.processes().values() {
            if p.pid().as_u32() == std::process::id()
                || p.user_id() != Some(uid)
                || !p.exists()
                || p.status() == ProcessStatus::Zombie
            {
                continue;
            }
            if p.pid().as_u32() == proof.pid
                && p.start_time() == proof.start_time
                && (p
                    .exe()
                    .map(|e| e.to_string_lossy().as_ref() != proof.executable)
                    .unwrap_or(true)
                    || !p.environ().iter().any(|e| e == OsStr::new(&marker)))
            {
                return Err("Cannot confirm ownership of the previous native process".into());
            }
            if p.parent() == Some(Pid::from_u32(proof.pid))
                && p.start_time() >= proof.start_time
                && p.environ().is_empty()
            {
                return Err(
                    "A process in the previous Agent family has unobservable ownership".into(),
                );
            }
            if p.start_time() >= proof.start_time
                && p.environ().iter().any(|e| e == OsStr::new(&marker))
            {
                matching += 1;
                if signalled.insert((p.pid(), p.start_time()))
                    && p.kill_with(Signal::Kill) != Some(true)
                {
                    return Err("Could not stop the owned native process".into());
                }
            }
        }
        if matching == 0 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("The previous native Agent has not confirmed a stop".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(all(test, unix))]
#[path = "task_adapter_tests.rs"]
mod tests;
