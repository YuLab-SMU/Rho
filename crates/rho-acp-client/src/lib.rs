#![forbid(unsafe_code)]
//! Thin client for external Agent Client Protocol processes.
//!
//! This crate does not implement an Agent, model provider, prompt loop, tool
//! harness, or project mutation. It connects Rho to an external ACP Agent and
//! projects public protocol events. Authority remains outside this crate.

use std::{
    collections::BTreeMap,
    ffi::OsStr,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
};

use agent_client_protocol::schema::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SessionNotification, SessionUpdate, TextContent,
};
use agent_client_protocol::{Agent, Client, ConnectionTo};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;

mod transport;

pub const MAX_ACP_EVENT_BYTES: usize = 128 * 1024;
pub const MAX_ACP_STDERR_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredAcpAgent {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub display_name: String,
    pub protocol: String,
}

pub fn discover_external_acp_agent(process_path: &OsStr) -> Option<DiscoveredAcpAgent> {
    let requested = std::env::var("RHO_ACP_AGENT").ok();
    let candidates = if let Some(requested) = requested {
        vec![(requested, Vec::new(), "External ACP Agent".to_string())]
    } else {
        vec![
            (
                "claude-code-acp".to_string(),
                Vec::new(),
                "Claude Code ACP".to_string(),
            ),
            ("codex-acp".to_string(), Vec::new(), "Codex ACP".to_string()),
            (
                "opencode".to_string(),
                vec!["acp".to_string(), "--pure".to_string()],
                "OpenCode ACP".to_string(),
            ),
        ]
    };
    let directories = std::env::split_paths(process_path).collect::<Vec<_>>();
    for (command, arguments, display_name) in candidates {
        let requested = std::path::Path::new(&command);
        if requested.is_absolute() && requested.is_file() {
            return Some(DiscoveredAcpAgent {
                executable: requested.canonicalize().ok()?,
                arguments,
                display_name,
                protocol: "acp/1".to_string(),
            });
        }
        for directory in &directories {
            let candidate = directory.join(&command);
            if candidate.is_file() {
                return Some(DiscoveredAcpAgent {
                    executable: candidate.canonicalize().ok()?,
                    arguments,
                    display_name,
                    protocol: "acp/1".to_string(),
                });
            }
            #[cfg(windows)]
            {
                let candidate = directory.join(format!("{command}.exe"));
                if candidate.is_file() {
                    return Some(DiscoveredAcpAgent {
                        executable: candidate.canonicalize().ok()?,
                        arguments,
                        display_name,
                        protocol: "acp/1".to_string(),
                    });
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcpClientBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> AcpClientBoundary {
    AcpClientBoundary {
        owns: &[
            "acp_process_connection",
            "acp_session_transport",
            "public_event_projection",
            "permission_delegation",
        ],
        does_not_own: &[
            "agent_implementation",
            "model_provider",
            "prompt_loop",
            "tool_harness",
            "policy_authority",
            "project_mutation",
            "workspace_execution",
            "store_append",
            "secret_resolution",
        ],
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifiedAcpSandbox {
    pub working_directory: PathBuf,
    pub authoritative_project_mounted: bool,
    pub workspace_socket_mounted: bool,
    pub store_mounted: bool,
    pub secret_store_mounted: bool,
    pub network_denied: bool,
}

impl VerifiedAcpSandbox {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.working_directory.is_absolute() && self.working_directory.is_dir(),
            "ACP working directory must be an existing absolute sandbox path"
        );
        ensure!(
            !self.authoritative_project_mounted
                && !self.workspace_socket_mounted
                && !self.store_mounted
                && !self.secret_store_mounted,
            "ACP Agent sandbox exposes an authoritative Rho owner"
        );
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct AcpProcessSpec {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub sandbox: VerifiedAcpSandbox,
}

impl std::fmt::Debug for AcpProcessSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AcpProcessSpec")
            .field("executable", &self.executable)
            .field("arguments", &self.arguments)
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("sandbox", &self.sandbox)
            .finish()
    }
}

impl AcpProcessSpec {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.executable.is_absolute() && self.executable.is_file(),
            "ACP Agent executable must be an existing absolute path"
        );
        const ALLOWED_ENVIRONMENT: &[&str] = &[
            "PATH",
            "HOME",
            "TMPDIR",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "SSL_CERT_FILE",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
        ];
        ensure!(
            self.environment
                .keys()
                .all(|key| ALLOWED_ENVIRONMENT.contains(&key.as_str())),
            "ACP Agent environment contains a key outside the exact allowlist"
        );
        self.sandbox.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcpClientEvent {
    MessageDelta { text: String },
    ToolCall { payload: Value },
    ToolCallUpdate { payload: Value },
    Plan { payload: Value },
    ModeChanged { payload: Value },
    ConfigChanged { payload: Value },
    SessionInfoChanged { payload: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcpTurnResult {
    pub session_id: String,
    pub stop_reason: String,
    pub final_text: String,
    pub events: Vec<AcpClientEvent>,
    pub permission_requests_denied: u64,
    pub stderr: String,
}

pub type AcpEventSink = Arc<dyn Fn(AcpClientEvent) + Send + Sync + 'static>;

fn bounded_json<T: Serialize>(value: &T) -> Option<Value> {
    let encoded = serde_json::to_vec(value).ok()?;
    if encoded.len() > MAX_ACP_EVENT_BYTES {
        return None;
    }
    serde_json::from_slice(&encoded).ok()
}

fn project_notification(notification: SessionNotification) -> Option<AcpClientEvent> {
    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => match chunk.content {
            ContentBlock::Text(text) => Some(AcpClientEvent::MessageDelta { text: text.text }),
            _ => None,
        },
        // Provider-private thought is deliberately not projected.
        SessionUpdate::AgentThoughtChunk(_) | SessionUpdate::UserMessageChunk(_) => None,
        SessionUpdate::ToolCall(value) => {
            bounded_json(&value).map(|payload| AcpClientEvent::ToolCall { payload })
        }
        SessionUpdate::ToolCallUpdate(value) => {
            bounded_json(&value).map(|payload| AcpClientEvent::ToolCallUpdate { payload })
        }
        SessionUpdate::Plan(value) => {
            bounded_json(&value).map(|payload| AcpClientEvent::Plan { payload })
        }
        SessionUpdate::CurrentModeUpdate(value) => {
            bounded_json(&value).map(|payload| AcpClientEvent::ModeChanged { payload })
        }
        SessionUpdate::ConfigOptionUpdate(value) => {
            bounded_json(&value).map(|payload| AcpClientEvent::ConfigChanged { payload })
        }
        SessionUpdate::SessionInfoUpdate(value) => {
            bounded_json(&value).map(|payload| AcpClientEvent::SessionInfoChanged { payload })
        }
        _ => None,
    }
}

pub async fn run_external_acp_turn(spec: AcpProcessSpec, prompt: String) -> Result<AcpTurnResult> {
    run_external_acp_turn_with_sink(spec, prompt, None).await
}

pub async fn run_external_acp_turn_with_sink(
    spec: AcpProcessSpec,
    prompt: String,
    live_sink: Option<AcpEventSink>,
) -> Result<AcpTurnResult> {
    spec.validate()?;
    ensure!(!prompt.trim().is_empty(), "ACP prompt is empty");

    let mut command = tokio::process::Command::new(&spec.executable);
    command
        .args(&spec.arguments)
        .current_dir(&spec.sandbox.working_directory)
        .env_clear()
        .envs(&spec.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().context("spawning external ACP Agent")?;
    let stdin = child.stdin.take().context("opening ACP Agent stdin")?;
    let stdout = child.stdout.take().context("opening ACP Agent stdout")?;
    let stderr = child.stderr.take().context("opening ACP Agent stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr
            .take(MAX_ACP_STDERR_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await;
        bytes.truncate(MAX_ACP_STDERR_BYTES);
        String::from_utf8_lossy(&bytes).into_owned()
    });

    let events = Arc::new(StdMutex::new(Vec::<AcpClientEvent>::new()));
    let final_text = Arc::new(StdMutex::new(String::new()));
    let denied = Arc::new(StdMutex::new(0_u64));
    let event_sink = Arc::clone(&events);
    let text_sink = Arc::clone(&final_text);
    let denied_sink = Arc::clone(&denied);
    let transport = transport::acp_transport(stdin, stdout);
    let working_directory = spec.sandbox.working_directory.clone();

    let turn = Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                if let Some(event) = project_notification(notification) {
                    if let AcpClientEvent::MessageDelta { text } = &event {
                        text_sink
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push_str(text);
                    }
                    event_sink
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(event.clone());
                    if let Some(sink) = live_sink.as_ref() {
                        sink(event);
                    }
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |_: RequestPermissionRequest, responder, _connection| {
                *denied_sink
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(
            transport,
            move |connection: ConnectionTo<Agent>| async move {
                let initialize = connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                let session = connection
                    .send_request(NewSessionRequest::new(working_directory))
                    .block_task()
                    .await?;
                let response = connection
                    .send_request(PromptRequest::new(
                        session.session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new(prompt))],
                    ))
                    .block_task()
                    .await?;
                Ok::<_, agent_client_protocol::Error>((
                    session.session_id.to_string(),
                    format!("{:?}", response.stop_reason),
                    initialize.agent_info,
                ))
            },
        )
        .await;

    let _ = child.kill().await;
    let _ = child.wait().await;
    let stderr = stderr_task.await.unwrap_or_default();
    let (session_id, stop_reason, _agent_info) =
        turn.map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let events = events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let final_text = final_text
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let permission_requests_denied = *denied
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Ok(AcpTurnResult {
        session_id,
        stop_reason,
        final_text,
        events,
        permission_requests_denied,
        stderr,
    })
}
