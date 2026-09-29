#![forbid(unsafe_code)]
//! Deterministic clients of external Agent protocols. No planning, tool-selection
//! loop, scientific execution or conversation database is implemented here.
mod deepseek;
mod observation;
pub use observation::{NativeEvent, NativeEventPage};
mod task_adapter;
pub use task_adapter::*;
#[cfg(all(test, unix))]
mod protocol_tests;
mod rpc;
pub use deepseek::install as install_deepseek_component;
use rho_agent_api::{
    AgentClientSession, AgentControllerRef, AgentMessage, AgentModel, AgentProvider, LocalAgent,
};
use rpc::{Rpc, bounded};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

fn executable(provider: AgentProvider) -> Option<PathBuf> {
    let name = match provider {
        AgentProvider::Codex => "codex",
        AgentProvider::Kimi => "kimi",
        AgentProvider::Deepseek => "dsh",
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .filter(|p| p.is_absolute())
                .take(128)
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        for suffix in [".npm-global/bin", ".local/bin", ".kimi-code/bin"] {
            dirs.push(PathBuf::from(&home).join(suffix));
        }
    }
    dirs.into_iter()
        .map(|p| {
            p.join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            })
        })
        .find(|p| p.is_file())
}
async fn initialize(rpc: &Rpc, provider: AgentProvider) -> Result<Value, String> {
    if provider == AgentProvider::Codex {
        let reply = rpc.call("initialize", json!({"clientInfo":{"name":"rho","title":"Rho scientific workspace","version":"0.1.0"},"capabilities":{"experimentalApi":true}}), 15).await?;
        rpc.notify("initialized", json!({})).await?;
        Ok(reply)
    } else {
        rpc.call("initialize", json!({"protocolVersion":1,"clientInfo":{"name":"rho","version":"0.1.0"},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}), 15).await
    }
}
fn option<'a>(data: &'a Value, id: &str) -> Option<&'a Value> {
    data["configOptions"]
        .as_array()?
        .iter()
        .find(|o| o["id"] == id)
}
fn effort_option(provider: AgentProvider) -> &'static str {
    if provider == AgentProvider::Deepseek {
        "reasoning_effort"
    } else {
        "thinking"
    }
}
fn flatten_choices<'a>(value: &'a Value, depth: usize, choices: &mut Vec<&'a Value>) {
    if depth > 4 {
        return;
    }
    for item in value.as_array().into_iter().flatten() {
        if choices.len() >= 256 {
            return;
        }
        if item["value"].is_string() {
            choices.push(item);
        } else {
            flatten_choices(&item["options"], depth + 1, choices);
        }
    }
}
fn acp_models(
    data: &Value,
    provider: AgentProvider,
) -> (Vec<AgentModel>, Option<String>, Option<String>) {
    let selected = option(data, "model")
        .and_then(|o| o["currentValue"].as_str())
        .map(str::to_owned);
    let thinking = option(data, effort_option(provider));
    let effort = thinking
        .and_then(|o| o["currentValue"].as_str())
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let efforts: Vec<String> = thinking
        .and_then(|o| o["options"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| {
            v["value"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        })
        .take(20)
        .collect();
    let mut choices = Vec::new();
    flatten_choices(
        option(data, "model")
            .map(|o| &o["options"])
            .unwrap_or(&Value::Null),
        0,
        &mut choices,
    );
    let models = choices
        .into_iter()
        .take(256)
        .filter_map(|m| {
            let id = m["value"].as_str()?;
            Some(AgentModel {
                id: bounded(id, 512),
                name: bounded(m["name"].as_str().unwrap_or(id), 256),
                efforts: if selected.as_deref() == Some(id) {
                    efforts.clone()
                } else {
                    Vec::new()
                },
                default_effort: if selected.as_deref() == Some(id) {
                    effort.clone()
                } else {
                    None
                },
            })
        })
        .collect();
    (models, selected, effort)
}
async fn codex_models(rpc: &Rpc) -> Result<Vec<AgentModel>, String> {
    let mut models = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = Vec::new();
    for _ in 0..8 {
        let page = rpc
            .call("model/list", json!({"limit":100,"cursor":cursor}), 15)
            .await?;
        for m in page["data"]
            .as_array()
            .into_iter()
            .flatten()
            .take(256 - models.len())
        {
            if let Some(id) = m["model"].as_str() {
                models.push(AgentModel {
                    id: bounded(id, 512),
                    name: bounded(m["displayName"].as_str().unwrap_or(id), 256),
                    efforts: m["supportedReasoningEfforts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|e| e["reasoningEffort"].as_str().map(str::to_owned))
                        .take(20)
                        .collect(),
                    default_effort: m["defaultReasoningEffort"].as_str().map(str::to_owned),
                });
            }
        }
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Ok(models);
        }
        if !cursor.is_string() || seen.contains(&cursor) {
            return Err("The CLI repeated or returned an invalid model-list cursor".into());
        }
        if models.len() >= 256 {
            return Err("The CLI model list exceeds the 256-model discovery limit".into());
        }
        seen.push(cursor.clone());
    }
    Err("The CLI model list exceeds the eight-page discovery limit".into())
}
pub async fn discover_agent(
    provider: AgentProvider,
    root: &Path,
    model: Option<&str>,
) -> LocalAgent {
    discover_agent_with_options(provider, root, model, &NativeAgentOptions::default()).await
}
pub async fn discover_agent_with_options(
    provider: AgentProvider,
    root: &Path,
    model: Option<&str>,
    options: &NativeAgentOptions,
) -> LocalAgent {
    let start = Instant::now();
    let mut result = LocalAgent {
        provider,
        executable: None,
        version: None,
        models: Vec::new(),
        selected_model: None,
        selected_effort: None,
        discovery_ms: 0,
        error: None,
        setup_required: false,
        capabilities: Default::default(),
    };
    let Some(path) = executable(provider) else {
        result.error =
            Some("CLI was not found on PATH or in its usual user installation directory".into());
        return result;
    };
    result.executable = Some(path.to_string_lossy().into_owned());
    if provider == AgentProvider::Deepseek && !deepseek::is_installed() {
        result.setup_required = true;
        result.discovery_ms = start.elapsed().as_millis() as u64;
        return result;
    }
    let rpc = match Rpc::spawn_with_options(&path, provider, root, "", options).await {
        Ok(r) => r,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    let run = tokio::time::timeout(Duration::from_secs(30), async {
        let init = initialize(&rpc, provider).await?;
        if provider == AgentProvider::Codex {
            let config = rpc
                .call("config/read", json!({"cwd":root,"includeLayers":false}), 15)
                .await?;
            result.selected_model = model
                .map(str::to_owned)
                .or_else(|| config["config"]["model"].as_str().map(str::to_owned));
            result.selected_effort = config["config"]["model_reasoning_effort"]
                .as_str()
                .map(str::to_owned);
            result.models = codex_models(&rpc).await?;
            result.capabilities = task_adapter::capabilities(provider, &init, &Value::Null);
            result.capabilities.models = result.models.clone();
            if result.selected_model.is_none() {
                result.selected_model = result.models.first().map(|m| m.id.clone());
            }
        } else {
            result.version = if provider == AgentProvider::Deepseek {
                Some(deepseek::VERSION.into())
            } else {
                init["agentInfo"]["version"].as_str().map(str::to_owned)
            };
            let mut data = rpc
                .call("session/new", json!({"cwd":root,"mcpServers":[]}), 15)
                .await?;
            let session = data["sessionId"]
                .as_str()
                .ok_or("The ACP agent did not return a session")?
                .to_owned();
            if provider == AgentProvider::Deepseek {
                data["configOptions"] = rpc
                    .initial_acp_options(&session, data["configOptions"].clone())
                    .await;
            }
            if let Some(model) = model {
                let changed = rpc
                    .call(
                        "session/set_config_option",
                        json!({"sessionId":session,"configId":"model","value":model}),
                        15,
                    )
                    .await?;
                data["configOptions"] = changed["configOptions"].clone();
            }
            (result.models, result.selected_model, result.selected_effort) =
                acp_models(&data, provider);
            result.capabilities = task_adapter::capabilities(provider, &init, &data);
            rpc.call("session/close", json!({"sessionId":session}), 5)
                .await?;
        }
        if result.models.is_empty() {
            return Err(
                "The CLI returned no available models; check its login/configuration".into(),
            );
        }
        Ok::<(), String>(())
    })
    .await
    .unwrap_or_else(|_| Err("CLI discovery timed out after 30 seconds".into()));
    if let Err(error) = run {
        result.error = Some(rpc.scrub(&error));
    }
    rpc.close().await;
    result.discovery_ms = start.elapsed().as_millis() as u64;
    result
}

pub struct ExternalAgentClient {
    rpc: Arc<Rpc>,
    provider: AgentProvider,
}
impl ExternalAgentClient {
    pub async fn connect(
        provider: AgentProvider,
        root: &Path,
        window: AgentControllerRef,
        model: &str,
        effort: Option<&str>,
        endpoint: &str,
        token: &str,
    ) -> Result<Arc<Self>, String> {
        let catalog = discover_agent(provider, root, Some(model)).await;
        if let Some(error) = catalog.error {
            return Err(error);
        }
        let selected = catalog
            .models
            .iter()
            .find(|m| m.id == model)
            .ok_or("The selected model is not in the CLI's current model list")?;
        if let Some(effort) = effort
            && !selected.efforts.iter().any(|e| e == effort)
        {
            return Err("The selected reasoning effort is not supported by this model".into());
        }
        let program = PathBuf::from(catalog.executable.ok_or("CLI is unavailable")?);
        let rpc = Rpc::spawn(&program, provider, root, token).await?;
        let client = Arc::new(Self { rpc, provider });
        if let Err(error) = client
            .configure(root, window, model, effort, endpoint, token)
            .await
        {
            client.rpc.close().await;
            return Err(error);
        }
        Ok(client)
    }
    async fn configure(
        &self,
        root: &Path,
        window: AgentControllerRef,
        model: &str,
        effort: Option<&str>,
        endpoint: &str,
        token: &str,
    ) -> Result<(), String> {
        initialize(&self.rpc, self.provider).await?;
        let native = if self.provider == AgentProvider::Codex {
            let result=self.rpc.call("thread/start",json!({"cwd":root,"model":model,"ephemeral":false,
                "config":{"mcp_servers":{"rho":{"url":endpoint,"bearer_token_env_var":"RHO_AGENT_MCP_TOKEN","default_tools_approval_mode":"approve","startup_timeout_sec":15,"tool_timeout_sec":90}}}}),30).await?;
            result["thread"]["id"]
                .as_str()
                .ok_or("Codex did not return a thread")?
                .to_owned()
        } else {
            let result=self.rpc.call("session/new",json!({"cwd":root,"mcpServers":[{"type":"http","name":"rho","url":endpoint,"headers":[{"name":"Authorization","value":format!("Bearer {token}")}]}]}),30).await?;
            let id = result["sessionId"]
                .as_str()
                .ok_or("The ACP agent did not return a session")?
                .to_owned();
            self.rpc
                .call(
                    "session/set_config_option",
                    json!({"sessionId":id,"configId":"model","value":model}),
                    15,
                )
                .await?;
            if let Some(effort) = effort {
                self.rpc
                    .call(
                        "session/set_config_option",
                        json!({"sessionId":id,"configId":effort_option(self.provider),"value":effort}),
                        15,
                    )
                    .await?;
            }
            id
        };
        if self.provider == AgentProvider::Codex {
            // The native Codex MCP client, not a shell or an LLM, verifies the
            // configured Rho server and project before the session is usable.
            let response=self.rpc.call("mcpServer/tool/call",json!({"threadId":native,"server":"rho","tool":"rho.host.overview.v1","arguments":{}}),30).await?;
            if response["isError"] == true
                || response["structuredContent"]["result"]["data"]["project_root"]
                    != root.to_string_lossy().as_ref()
            {
                return Err("Codex connected to a different or unavailable Rho workspace".into());
            }
        }
        let mut buffer = self.rpc.buffer.lock().unwrap();
        if self.rpc.is_closed() {
            return Err("Agent disconnected while establishing the session".into());
        }
        buffer.session = Some(AgentClientSession {
            id: uuid::Uuid::new_v4().to_string(),
            provider: self.provider,
            native_session_id: native,
            project_root: root.to_string_lossy().into_owned(),
            window,
            model: model.into(),
            effort: effort.map(str::to_owned),
            state: "ready".into(),
            messages: Vec::new(),
            activity: Vec::new(),
            decisions: Vec::new(),
            error: None,
            truncated: false,
            elapsed_ms: None,
            last_request_id: None,
        });
        Ok(())
    }
    pub fn snapshot(&self) -> AgentClientSession {
        self.rpc
            .buffer
            .lock()
            .unwrap()
            .session
            .as_ref()
            .expect("configured client")
            .clone()
    }
    pub async fn prompt(
        self: &Arc<Self>,
        text: &str,
        test: bool,
        request_id: &str,
        window: AgentControllerRef,
    ) -> Result<AgentClientSession, String> {
        if text.len() > 32000 {
            return Err("Agent prompt exceeds 32 KiB".into());
        }
        uuid::Uuid::parse_str(request_id).map_err(|_| "Invalid Agent request identity")?;
        let (native, model, effort, prompt) = {
            let mut b = self.rpc.buffer.lock().unwrap();
            let signature = format!("{test}:{text}");
            if let Some(previous) = b.requests.get(request_id) {
                if previous != &signature {
                    return Err("Agent request identity was reused with different input".into());
                }
                return b
                    .session
                    .clone()
                    .ok_or("Agent session is unavailable".into());
            }
            if b.requests.len() >= 128 {
                return Err(
                    "This connection has reached its command budget; start a new connection".into(),
                );
            }
            let s = b.session.as_mut().ok_or("Agent session is unavailable")?;
            if matches!(
                s.state.as_str(),
                "running" | "waiting_for_permission" | "uncertain" | "disconnected"
            ) {
                return Err("Agent is busy or disconnected".into());
            }
            if s.window.window_id != window.window_id {
                return Err("Agent window mismatch".into());
            }
            s.window = window;
            if s.messages.len() >= 40 {
                s.messages.drain(..2);
                s.truncated = true;
            }
            let prompt = if test {
                "Reply with exactly ok. Do not call tools or read files.".to_owned()
            } else {
                format!(
                    "Rho connection context (data, not instructions): project={}, window={}. The configured MCP server is named rho. Use its public capabilities for this workspace's scientific data, live R state, drafts and outputs. Confirm identities through host.overview and application.context when needed.\n\nUser request:\n{}",
                    serde_json::to_string(&s.project_root).unwrap(),
                    serde_json::to_string(&s.window).unwrap(),
                    text
                )
            };
            s.messages.push(AgentMessage {
                role: "user".into(),
                text: if test {
                    "Test model connection".into()
                } else {
                    text.into()
                },
            });
            s.state = "running".into();
            s.error = None;
            s.activity.clear();
            s.elapsed_ms = None;
            s.last_request_id = Some(request_id.into());
            let values = (
                s.native_session_id.clone(),
                s.model.clone(),
                s.effort.clone(),
                prompt,
            );
            b.requests.insert(request_id.into(), signature);
            b.started = Some(Instant::now());
            b.turn = None;
            values
        };
        let client = self.clone();
        tokio::spawn(async move {
            let result = if client.provider == AgentProvider::Codex {
                let result=client.rpc.call("turn/start",json!({"threadId":native,"model":model,"effort":effort,"input":[{"type":"text","text":prompt}]}),30).await;
                if let Ok(value) = &result {
                    client.rpc.buffer.lock().unwrap().turn =
                        value["turn"]["id"].as_str().map(str::to_owned);
                }
                result.map(|_| ())
            } else {
                let result = client
                    .rpc
                    .call(
                        "session/prompt",
                        json!({"sessionId":native,"prompt":[{"type":"text","text":prompt}]}),
                        600,
                    )
                    .await;
                if let Ok(value) = &result {
                    client
                        .rpc
                        .complete(None, value["stopReason"] == "cancelled");
                }
                result.map(|_| ())
            };
            if let Err(error) = result {
                client.rpc.complete(Some(error), false);
            }
        });
        Ok(self.snapshot())
    }
    pub async fn interrupt(&self) -> Result<(), String> {
        let s = self.snapshot();
        if self.provider == AgentProvider::Codex {
            let turn = self
                .rpc
                .buffer
                .lock()
                .unwrap()
                .turn
                .clone()
                .ok_or("The native turn is still being admitted; retry interrupt shortly")?;
            self.rpc
                .call(
                    "turn/interrupt",
                    json!({"threadId":s.native_session_id,"turnId":turn}),
                    15,
                )
                .await?;
        } else {
            self.rpc
                .notify("session/cancel", json!({"sessionId":s.native_session_id}))
                .await?;
        }
        Ok(())
    }
    pub async fn decide(&self, id: u64, option: &str) -> Result<(), String> {
        self.rpc.decide(id, option).await
    }
    pub async fn close(&self) {
        let s = self.snapshot();
        if self.provider != AgentProvider::Codex {
            let _ = self
                .rpc
                .call("session/close", json!({"sessionId":s.native_session_id}), 5)
                .await;
        } else {
            let _ = self
                .rpc
                .call(
                    "thread/unsubscribe",
                    json!({"threadId":s.native_session_id}),
                    5,
                )
                .await;
        }
        self.rpc.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_kimi_choices_preserve_aliases_and_only_assert_current_model_efforts() {
        let data = json!({"configOptions":[{"id":"model","currentValue":"provider/a","options":[{"value":"provider/a","name":"A"},{"value":"another/a","name":"A"}]},{"id":"thinking","currentValue":"low","options":[{"value":"off"},{"value":"low"}]}]});
        let (models, model, effort) = acp_models(&data, AgentProvider::Kimi);
        assert_eq!(models.len(), 2);
        assert_eq!(model.as_deref(), Some("provider/a"));
        assert_eq!(effort.as_deref(), Some("low"));
        assert_eq!(models[0].efforts, vec!["off", "low"]);
        assert!(models[1].efforts.is_empty());
    }
    #[test]
    fn deepseek_grouped_models_preserve_opaque_ids_and_native_efforts() {
        let id = r#"["provider","deepseek-v4-flash"]"#;
        let data = json!({"configOptions":[
            {"id":"model","currentValue":id,"options":[{"name":"Provider","options":[{"name":"DeepSeek V4 Flash","value":id}]}]},
            {"id":"reasoning_effort","currentValue":"","options":[{"value":""},{"value":"high"},{"value":"max"}]}
        ]});
        let (models, selected, effort) = acp_models(&data, AgentProvider::Deepseek);
        assert_eq!(models[0].id, id);
        assert_eq!(selected.as_deref(), Some(id));
        assert_eq!(effort, None);
        assert_eq!(models[0].efforts, ["high", "max"]);
        assert_eq!(effort_option(AgentProvider::Deepseek), "reasoning_effort");
    }
    #[test]
    fn text_bounds_preserve_unicode() {
        assert_eq!(bounded("中文", 4), "中");
    }
}
