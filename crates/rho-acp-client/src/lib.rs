#![forbid(unsafe_code)]
//! Thin client for external Agent Client Protocol processes.
//!
//! This crate does not implement an Agent, model provider, prompt loop, tool
//! harness, or project mutation. It connects Rho to an external ACP Agent and
//! projects public protocol events. Authority remains outside this crate.

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use agent_client_protocol::schema::{
    ClientCapabilities, ContentBlock, CreateTerminalRequest, CreateTerminalResponse, EnvVariable,
    FileSystemCapabilities, InitializeRequest, KillTerminalRequest, KillTerminalResponse,
    McpServer, McpServerStdio, NewSessionRequest, PermissionOptionKind, PromptRequest,
    ProtocolVersion, ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest,
    ReleaseTerminalResponse, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
    TerminalExitStatus, TerminalOutputRequest, TerminalOutputResponse, TextContent,
    WaitForTerminalExitRequest, WaitForTerminalExitResponse, WriteTextFileRequest,
    WriteTextFileResponse,
};
use agent_client_protocol::{Agent, Client, ConnectionTo};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};

mod transport;

pub const MAX_ACP_EVENT_BYTES: usize = 128 * 1024;
pub const MAX_ACP_STDERR_BYTES: usize = 16 * 1024;
pub const MAX_ACP_TEXT_FILE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ACP_TEXT_FILE_LINES: u32 = 100_000;
pub const DEFAULT_ACP_TERMINAL_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_ACP_TERMINAL_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ACP_TERMINALS: usize = 16;

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
            "disposable_workspace_filesystem",
            "disposable_workspace_terminal",
            "mcp_session_projection",
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

/// Client-side capabilities made available to an external ACP Agent for one
/// disposable turn. Rho advertises only handlers that are actually installed.
/// Domain-specific Workspace, Environment, Artifact and Evidence operations are
/// supplied separately as MCP servers.
#[derive(Debug, Clone)]
pub struct AcpClientExposure {
    file_system: bool,
    terminal: bool,
    trust_agent_permission_requests: bool,
    mcp_servers: Vec<McpServer>,
}

impl AcpClientExposure {
    /// Expose the disposable Workspace snapshot for bounded text-file access and
    /// honor permission requests already chosen by the external Agent's mode.
    pub fn workspace_snapshot() -> Self {
        Self {
            file_system: true,
            terminal: true,
            trust_agent_permission_requests: true,
            mcp_servers: Vec::new(),
        }
    }

    /// Attach Rho domain capability servers to the ACP session. ACP requires
    /// every Agent to support the stdio MCP transport.
    pub fn with_mcp_servers(mut self, mcp_servers: Vec<McpServer>) -> Self {
        self.mcp_servers = mcp_servers;
        self
    }

    pub fn with_stdio_mcp_server(
        mut self,
        name: impl Into<String>,
        command: impl Into<PathBuf>,
        args: Vec<String>,
        environment: BTreeMap<String, String>,
    ) -> Self {
        let server = McpServerStdio::new(name, command).args(args).env(
            environment
                .into_iter()
                .map(|(name, value)| EnvVariable::new(name, value))
                .collect(),
        );
        self.mcp_servers.push(McpServer::Stdio(server));
        self
    }

    fn client_capabilities(&self) -> ClientCapabilities {
        ClientCapabilities::new()
            .fs(FileSystemCapabilities::new()
                .read_text_file(self.file_system)
                .write_text_file(self.file_system))
            .terminal(self.terminal)
    }
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
    pub permission_requests_selected: u64,
    pub workspace_file_reads: u64,
    pub workspace_file_writes: u64,
    pub terminal_commands_created: u64,
    pub stderr: String,
}

struct TerminalOutputBuffer {
    output: String,
    truncated: bool,
    byte_limit: usize,
}

impl TerminalOutputBuffer {
    fn new(byte_limit: usize) -> Self {
        Self {
            output: String::new(),
            truncated: false,
            byte_limit,
        }
    }

    fn append(&mut self, bytes: &[u8]) {
        self.output.push_str(&String::from_utf8_lossy(bytes));
        if self.output.len() <= self.byte_limit {
            return;
        }
        self.truncated = true;
        let mut start = self.output.len().saturating_sub(self.byte_limit);
        while start < self.output.len() && !self.output.is_char_boundary(start) {
            start += 1;
        }
        self.output.drain(..start);
    }
}

struct ManagedTerminal {
    child: tokio::sync::Mutex<Option<tokio::process::Child>>,
    readers: tokio::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    output: Arc<StdMutex<TerminalOutputBuffer>>,
    exit_status: StdMutex<Option<TerminalExitStatus>>,
}

impl ManagedTerminal {
    async fn refresh_status(&self) -> Result<Option<TerminalExitStatus>> {
        if let Some(status) = self
            .exit_status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            return Ok(Some(status));
        }
        let status = {
            let mut child = self.child.lock().await;
            match child.as_mut() {
                Some(process) => process
                    .try_wait()
                    .context("observing an ACP terminal process")?,
                None => None,
            }
        };
        if let Some(status) = status {
            let status = terminal_exit_status(status);
            *self
                .exit_status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(status.clone());
            self.finish_readers().await;
            Ok(Some(status))
        } else {
            Ok(None)
        }
    }

    async fn wait(&self) -> Result<TerminalExitStatus> {
        if let Some(status) = self.refresh_status().await? {
            return Ok(status);
        }
        let status = {
            let mut child = self.child.lock().await;
            let process = child
                .as_mut()
                .context("ACP terminal process was released")?;
            process
                .wait()
                .await
                .context("waiting for ACP terminal process")?
        };
        let status = terminal_exit_status(status);
        *self
            .exit_status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(status.clone());
        self.finish_readers().await;
        Ok(status)
    }

    async fn kill(&self) -> Result<()> {
        let mut child = self.child.lock().await;
        if let Some(process) = child.as_mut()
            && process
                .try_wait()
                .context("observing an ACP terminal before cancellation")?
                .is_none()
        {
            process.kill().await.context("cancelling an ACP terminal")?;
        }
        Ok(())
    }

    async fn finish_readers(&self) {
        let readers = std::mem::take(&mut *self.readers.lock().await);
        for mut reader in readers {
            if tokio::time::timeout(Duration::from_secs(1), &mut reader)
                .await
                .is_err()
            {
                reader.abort();
                let _ = reader.await;
            }
        }
    }

    fn output_snapshot(&self) -> (String, bool) {
        let output = self
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (output.output.clone(), output.truncated)
    }
}

#[derive(Clone)]
struct AcpTerminalManager {
    root: PathBuf,
    environment: BTreeMap<String, String>,
    next_id: Arc<AtomicU64>,
    terminals: Arc<tokio::sync::Mutex<HashMap<String, Arc<ManagedTerminal>>>>,
}

impl AcpTerminalManager {
    fn new(root: PathBuf, environment: BTreeMap<String, String>) -> Self {
        Self {
            root,
            environment,
            next_id: Arc::new(AtomicU64::new(1)),
            terminals: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    async fn create(&self, request: &CreateTerminalRequest) -> Result<String> {
        ensure!(
            !request.command.trim().is_empty(),
            "ACP terminal command is empty"
        );
        ensure!(
            self.terminals.lock().await.len() < MAX_ACP_TERMINALS,
            "ACP terminal count exceeds the configured bound"
        );
        let requested_limit = request
            .output_byte_limit
            .map(usize::try_from)
            .transpose()
            .context("ACP terminal output bound exceeds this platform")?
            .unwrap_or(DEFAULT_ACP_TERMINAL_OUTPUT_BYTES);
        ensure!(
            requested_limit <= MAX_ACP_TERMINAL_OUTPUT_BYTES,
            "ACP terminal output bound exceeds the configured maximum"
        );
        let cwd = match request.cwd.as_deref() {
            Some(cwd) => contained_workspace_directory(&self.root, cwd)?,
            None => std::fs::canonicalize(&self.root)
                .context("canonicalizing the disposable ACP Workspace")?,
        };
        let mut command = tokio::process::Command::new(&request.command);
        command
            .args(&request.args)
            .current_dir(cwd)
            .env_clear()
            .envs(&self.environment)
            .envs(request.env.iter().map(|entry| (&entry.name, &entry.value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .context("spawning an ACP terminal command")?;
        let output = Arc::new(StdMutex::new(TerminalOutputBuffer::new(requested_limit)));
        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            readers.push(spawn_terminal_reader(stdout, Arc::clone(&output)));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(spawn_terminal_reader(stderr, Arc::clone(&output)));
        }
        let id = format!(
            "rho-terminal-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let terminal = Arc::new(ManagedTerminal {
            child: tokio::sync::Mutex::new(Some(child)),
            readers: tokio::sync::Mutex::new(readers),
            output,
            exit_status: StdMutex::new(None),
        });
        let mut terminals = self.terminals.lock().await;
        ensure!(
            terminals.len() < MAX_ACP_TERMINALS,
            "ACP terminal count exceeds the configured bound"
        );
        terminals.insert(id.clone(), terminal);
        Ok(id)
    }

    async fn get(&self, id: &str) -> Result<Arc<ManagedTerminal>> {
        self.terminals
            .lock()
            .await
            .get(id)
            .cloned()
            .context("ACP terminal is unknown or already released")
    }

    async fn release(&self, id: &str) -> Result<()> {
        let terminal = self
            .terminals
            .lock()
            .await
            .remove(id)
            .context("ACP terminal is unknown or already released")?;
        terminal.kill().await?;
        terminal.finish_readers().await;
        Ok(())
    }
}

fn spawn_terminal_reader(
    mut reader: impl AsyncRead + Unpin + Send + 'static,
    output: Arc<StdMutex<TerminalOutputBuffer>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut bytes = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut bytes).await {
                Ok(0) | Err(_) => break,
                Ok(count) => output
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .append(&bytes[..count]),
            }
        }
    })
}

fn terminal_exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    TerminalExitStatus::new().exit_code(status.code().and_then(|code| u32::try_from(code).ok()))
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
    run_external_acp_turn_with_exposure(spec, prompt, None, AcpClientExposure::workspace_snapshot())
        .await
}

pub async fn run_external_acp_turn_with_sink(
    spec: AcpProcessSpec,
    prompt: String,
    live_sink: Option<AcpEventSink>,
) -> Result<AcpTurnResult> {
    run_external_acp_turn_with_exposure(
        spec,
        prompt,
        live_sink,
        AcpClientExposure::workspace_snapshot(),
    )
    .await
}

pub async fn run_external_acp_turn_with_exposure(
    spec: AcpProcessSpec,
    prompt: String,
    live_sink: Option<AcpEventSink>,
    exposure: AcpClientExposure,
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
    let selected = Arc::new(AtomicU64::new(0));
    let file_reads = Arc::new(AtomicU64::new(0));
    let file_writes = Arc::new(AtomicU64::new(0));
    let terminal_commands = Arc::new(AtomicU64::new(0));
    let event_sink = Arc::clone(&events);
    let text_sink = Arc::clone(&final_text);
    let denied_sink = Arc::clone(&denied);
    let selected_sink = Arc::clone(&selected);
    let read_sink = Arc::clone(&file_reads);
    let write_sink = Arc::clone(&file_writes);
    let terminal_sink = Arc::clone(&terminal_commands);
    let transport = transport::acp_transport(stdin, stdout);
    let working_directory = spec.sandbox.working_directory.clone();
    let read_root = working_directory.clone();
    let write_root = working_directory.clone();
    let terminal_manager =
        AcpTerminalManager::new(working_directory.clone(), spec.environment.clone());
    let create_terminal_manager = terminal_manager.clone();
    let output_terminal_manager = terminal_manager.clone();
    let wait_terminal_manager = terminal_manager.clone();
    let kill_terminal_manager = terminal_manager.clone();
    let release_terminal_manager = terminal_manager;
    let file_system_enabled = exposure.file_system;
    let terminal_enabled = exposure.terminal;
    let trust_agent_permission_requests = exposure.trust_agent_permission_requests;
    let client_capabilities = exposure.client_capabilities();
    let mcp_servers = exposure.mcp_servers;

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
            async move |request: ReadTextFileRequest, responder, _connection| {
                if !file_system_enabled {
                    return responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                match read_workspace_text_file(&read_root, &request).await {
                    Ok(content) => {
                        read_sink.fetch_add(1, Ordering::Relaxed);
                        responder.respond(ReadTextFileResponse::new(content))
                    }
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params().data(error.to_string()),
                    ),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WriteTextFileRequest, responder, _connection| {
                if !file_system_enabled {
                    return responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                match write_workspace_text_file(&write_root, &request).await {
                    Ok(()) => {
                        write_sink.fetch_add(1, Ordering::Relaxed);
                        responder.respond(WriteTextFileResponse::new())
                    }
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params().data(error.to_string()),
                    ),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateTerminalRequest, responder, _connection| {
                if !terminal_enabled {
                    return responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                match create_terminal_manager.create(&request).await {
                    Ok(terminal_id) => {
                        terminal_sink.fetch_add(1, Ordering::Relaxed);
                        responder.respond(CreateTerminalResponse::new(terminal_id))
                    }
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params().data(error.to_string()),
                    ),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: TerminalOutputRequest, responder, _connection| {
                if !terminal_enabled {
                    return responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                let result = async {
                    let terminal = output_terminal_manager
                        .get(&request.terminal_id.to_string())
                        .await?;
                    let exit_status = terminal.refresh_status().await?;
                    let (output, truncated) = terminal.output_snapshot();
                    Ok::<_, anyhow::Error>(
                        TerminalOutputResponse::new(output, truncated).exit_status(exit_status),
                    )
                }
                .await;
                match result {
                    Ok(response) => responder.respond(response),
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params().data(error.to_string()),
                    ),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WaitForTerminalExitRequest, responder, _connection| {
                if !terminal_enabled {
                    return responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                let result = async {
                    wait_terminal_manager
                        .get(&request.terminal_id.to_string())
                        .await?
                        .wait()
                        .await
                }
                .await;
                match result {
                    Ok(status) => responder.respond(WaitForTerminalExitResponse::new(status)),
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params().data(error.to_string()),
                    ),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: KillTerminalRequest, responder, _connection| {
                if !terminal_enabled {
                    return responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                let result = async {
                    kill_terminal_manager
                        .get(&request.terminal_id.to_string())
                        .await?
                        .kill()
                        .await
                }
                .await;
                match result {
                    Ok(()) => responder.respond(KillTerminalResponse::new()),
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params().data(error.to_string()),
                    ),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReleaseTerminalRequest, responder, _connection| {
                if !terminal_enabled {
                    return responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
                match release_terminal_manager
                    .release(&request.terminal_id.to_string())
                    .await
                {
                    Ok(()) => responder.respond(ReleaseTerminalResponse::new()),
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params().data(error.to_string()),
                    ),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let selected_option = trust_agent_permission_requests
                    .then(|| {
                        request
                            .options
                            .iter()
                            .find(|option| option.kind == PermissionOptionKind::AllowOnce)
                            .or_else(|| {
                                request
                                    .options
                                    .iter()
                                    .find(|option| option.kind == PermissionOptionKind::AllowAlways)
                            })
                            .map(|option| option.option_id.clone())
                    })
                    .flatten();
                if let Some(option_id) = selected_option {
                    selected_sink.fetch_add(1, Ordering::Relaxed);
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                            option_id,
                        )),
                    ))
                } else {
                    *denied_sink
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(
            transport,
            move |connection: ConnectionTo<Agent>| async move {
                let initialize = connection
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_capabilities(client_capabilities),
                    )
                    .block_task()
                    .await?;
                let session = connection
                    .send_request(
                        NewSessionRequest::new(working_directory).mcp_servers(mcp_servers),
                    )
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
        permission_requests_selected: selected.load(Ordering::Relaxed),
        workspace_file_reads: file_reads.load(Ordering::Relaxed),
        workspace_file_writes: file_writes.load(Ordering::Relaxed),
        terminal_commands_created: terminal_commands.load(Ordering::Relaxed),
        stderr,
    })
}

fn relative_workspace_path(root: &Path, requested: &Path) -> Result<PathBuf> {
    ensure!(requested.is_absolute(), "ACP file path must be absolute");
    let relative = requested
        .strip_prefix(root)
        .context("ACP file path is outside the disposable Workspace")?;
    ensure!(
        !relative.as_os_str().is_empty(),
        "ACP file path must identify a file"
    );
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            bail!("ACP file path contains a non-normal component");
        }
    }
    Ok(relative.to_path_buf())
}

fn contained_existing_path(root: &Path, requested: &Path) -> Result<PathBuf> {
    let relative = relative_workspace_path(root, requested)?;
    let canonical_root =
        std::fs::canonicalize(root).context("canonicalizing the disposable ACP Workspace")?;
    let candidate =
        std::fs::canonicalize(root.join(relative)).context("resolving the requested ACP file")?;
    ensure!(
        candidate.starts_with(&canonical_root),
        "ACP file path resolves outside the disposable Workspace"
    );
    Ok(candidate)
}

fn contained_workspace_directory(root: &Path, requested: &Path) -> Result<PathBuf> {
    ensure!(requested.is_absolute(), "ACP terminal cwd must be absolute");
    let canonical_root =
        std::fs::canonicalize(root).context("canonicalizing the disposable ACP Workspace")?;
    let candidate = std::fs::canonicalize(requested).context("resolving the ACP terminal cwd")?;
    ensure!(
        candidate.starts_with(&canonical_root),
        "ACP terminal cwd resolves outside the disposable Workspace"
    );
    ensure!(candidate.is_dir(), "ACP terminal cwd is not a directory");
    Ok(candidate)
}

async fn read_workspace_text_file(root: &Path, request: &ReadTextFileRequest) -> Result<String> {
    if let Some(line) = request.line {
        ensure!(line > 0, "ACP text-file line is one-based");
    }
    if let Some(limit) = request.limit {
        ensure!(
            limit <= MAX_ACP_TEXT_FILE_LINES,
            "ACP text-file line limit exceeds the configured bound"
        );
    }
    let path = contained_existing_path(root, &request.path)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .context("reading ACP text-file metadata")?;
    ensure!(metadata.is_file(), "ACP text-file path is not a file");
    ensure!(
        metadata.len() <= MAX_ACP_TEXT_FILE_BYTES as u64,
        "ACP text file exceeds the configured byte bound"
    );
    let bytes = tokio::fs::read(path)
        .await
        .context("reading ACP text file")?;
    let content = String::from_utf8(bytes).context("ACP text file is not valid UTF-8")?;
    if request.line.is_none() && request.limit.is_none() {
        return Ok(content);
    }
    let start = request.line.unwrap_or(1).saturating_sub(1) as usize;
    let limit = request.limit.unwrap_or(MAX_ACP_TEXT_FILE_LINES) as usize;
    Ok(content
        .split_inclusive('\n')
        .skip(start)
        .take(limit)
        .collect())
}

fn prepare_contained_write_path(root: &Path, requested: &Path) -> Result<PathBuf> {
    let relative = relative_workspace_path(root, requested)?;
    let canonical_root =
        std::fs::canonicalize(root).context("canonicalizing the disposable ACP Workspace")?;
    let mut current = root.to_path_buf();
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            let Component::Normal(segment) = component else {
                bail!("ACP file parent contains a non-normal component");
            };
            current.push(segment);
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) => ensure!(
                    !metadata.file_type().is_symlink() && metadata.is_dir(),
                    "ACP file parent is not a regular directory"
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&current)
                        .context("creating an ACP file parent directory")?;
                }
                Err(error) => return Err(error).context("inspecting an ACP file parent"),
            }
        }
    }
    let canonical_parent =
        std::fs::canonicalize(root.join(relative.parent().unwrap_or_else(|| Path::new(""))))
            .context("canonicalizing an ACP file parent")?;
    ensure!(
        canonical_parent.starts_with(&canonical_root),
        "ACP file parent resolves outside the disposable Workspace"
    );
    let candidate = root.join(relative);
    if let Ok(metadata) = std::fs::symlink_metadata(&candidate) {
        ensure!(
            !metadata.file_type().is_symlink() && metadata.is_file(),
            "ACP file target is not a regular file"
        );
    }
    Ok(candidate)
}

async fn write_workspace_text_file(root: &Path, request: &WriteTextFileRequest) -> Result<()> {
    ensure!(
        request.content.len() <= MAX_ACP_TEXT_FILE_BYTES,
        "ACP text file exceeds the configured byte bound"
    );
    let path = prepare_contained_write_path(root, &request.path)?;
    tokio::fs::write(path, request.content.as_bytes())
        .await
        .context("writing ACP text file")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workspace_file_handlers_are_bounded_and_project_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.txt");
        std::fs::write(&source, "one\ntwo\nthree\n").unwrap();

        let read = ReadTextFileRequest::new("session", &source)
            .line(2)
            .limit(1);
        assert_eq!(
            read_workspace_text_file(&root, &read).await.unwrap(),
            "two\n"
        );

        let target = root.join("nested/result.txt");
        write_workspace_text_file(
            &root,
            &WriteTextFileRequest::new("session", &target, "result"),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(target).unwrap(), "result");

        let outside = directory.path().join("outside.txt");
        assert!(
            write_workspace_text_file(
                &root,
                &WriteTextFileRequest::new("session", outside, "escape"),
            )
            .await
            .is_err()
        );
    }

    #[test]
    fn terminal_output_truncates_from_the_front_at_a_utf8_boundary() {
        let mut output = TerminalOutputBuffer::new(5);
        output.append("old-新".as_bytes());
        assert!(output.truncated);
        assert!(output.output.len() <= 5);
        assert!(output.output.ends_with('新'));
    }
}
