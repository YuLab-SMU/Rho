#![forbid(unsafe_code)]
mod checkpoints;
mod outputs;
pub mod recovery;
pub use checkpoints::{CheckpointArchiveRuntime, recorded_process_alive, verify_checkpoint_helper};
pub use outputs::OutputStore;

use async_trait::async_trait;
use jet_core::{
    client::{Client, KernelStatus, ListenFilter},
    jupyter_protocol::{
        ExecuteRequest, ExecutionState, InputReply, IsCompleteRequest, JupyterMessage,
        JupyterMessageContent, Stdio,
    },
    kernel_spec::{InterruptMode, KernelSpec},
};
use rho_plugin_protocol::PluginOutcome as OperationOutcome;
use rho_r_api::{
    BindingSummary, FormatArguments, HelpArguments, InspectArguments, LintArguments, NativeError,
    NativeObservation, NativeReport, NativeRuntime, RunRArguments, SnapshotArguments,
    WorkspaceQuery, WorkspaceSnapshotData, WorkspaceToolRequest,
};
use rho_r_api::{NativeCompleteness, NativeEffect, OperationId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::watch, time::Instant};
use uuid::Uuid;

const BRIDGE: &str = include_str!("../r/bridge/dispatch.R");
const QUERIES: &str = include_str!("../r/bridge/query.R");
const PACKAGES: &str = include_str!("../r/bridge/packages.R");
const OBJECTS: &str = include_str!("../r/bridge/objects.R");
const PACKAGE_INDEX: &str = include_str!("../r/bridge/package-index.R");
const CHECKPOINTS: &str = include_str!("../r/bridge/checkpoint.R");
const TOOLS: &str = include_str!("../r/bridge/tools.R");
const OUTPUT_LIMIT: usize = 1024 * 1024;
const RUN_CONNECTION_LOST: &str = "R session connection was lost. The run result is not confirmed. Inspect the original run before retrying.";

pub struct ArkConfig {
    pub checkpoint_helper_path: Option<PathBuf>,
    pub executable: PathBuf,
    pub r_home: PathBuf,
    pub project_root: PathBuf,
    pub data_root: PathBuf,
    pub execution_timeout: Duration,
    pub library_path: Option<PathBuf>,
}

struct ActiveInput {
    public: rho_r_api::InputRequest,
    message: JupyterMessage,
    started: Instant,
    submitted_at: Option<Instant>,
    echo: Option<String>,
}
pub struct ArkRuntime {
    checkpoints: checkpoints::CheckpointStore,
    checkpoint_ready: bool,
    native_process: Option<(u32, u64)>,
    installation: Option<rho_r_api::RuntimeInstallationIdentity>,
    client: Mutex<Option<Arc<Client>>>,
    session_id: String,
    project_root: String,
    library_path: Option<String>,
    data_root: PathBuf,
    timeout: Duration,
    input: Mutex<Option<ActiveInput>>,
    input_changed: watch::Sender<u64>,
    closing: std::sync::atomic::AtomicBool,
    outputs: outputs::OutputStore,
    resources: Mutex<(sysinfo::System, bool)>,
}

impl ArkRuntime {
    pub async fn launch(config: ArkConfig) -> Result<Self, String> {
        let ark = config
            .executable
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let project = config
            .project_root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !project.is_dir() {
            return Err("project root is not a directory".into());
        }
        if config.execution_timeout.is_zero() {
            return Err("execution timeout must be positive".into());
        }
        // Refuse an invalid native component before starting any child process.
        let helper = config
            .checkpoint_helper_path
            .as_ref()
            .map(|p| checkpoints::verify_checkpoint_helper(p, &config.r_home))
            .transpose()?;
        let session_id = format!("ark_{}", Uuid::new_v4().simple());
        let data_root = config.data_root.join(&session_id);
        std::fs::create_dir_all(&data_root).map_err(|error| error.to_string())?;
        let data_root = data_root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut env = HashMap::new();
        env.insert(
            "R_HOME".into(),
            config.r_home.to_string_lossy().into_owned(),
        );
        // The selected R installation supplies its normal library paths. Startup user scripts
        // are disabled for this host-owned session; no model/provider credentials are injected.
        let spec = KernelSpec {
            argv: vec![
                ark.to_string_lossy().into_owned(),
                "--connection_file".into(),
                "{connection_file}".into(),
                "--session-mode".into(),
                "console".into(),
                "--default-repos".into(),
                "none".into(),
                "--log".into(),
                data_root.join("ark.log").to_string_lossy().into_owned(),
                "--".into(),
                "--vanilla".into(),
                "--interactive".into(),
            ],
            language: "R".into(),
            display_name: Some("Rho Next".into()),
            interrupt_mode: InterruptMode::Message,
            env,
            env_remove: std::env::vars_os()
                .filter_map(|(name, _)| name.into_string().ok())
                .filter(|name| {
                    let n = name.to_ascii_uppercase();
                    n.contains("TOKEN")
                        || n.contains("SECRET")
                        || n.contains("PASSWORD")
                        || n.ends_with("KEY")
                })
                .collect(),
            metadata: HashMap::new(),
            kernel_protocol_version: Some("5.4".into()),
        };
        let (client, _, boot) = tokio::time::timeout(
            Duration::from_secs(30),
            Client::spawn(&spec, None, Some("rho-next"), Some(session_id.clone())),
        )
        .await
        .map_err(|_| "Ark startup timed out".to_string())?
        .map_err(|error| error.to_string())?;
        drop(boot);
        let native_process = match client.child_pid() {
            Some(pid) => checkpoints::process_start(pid)
                .await
                .map_err(|e| e.message)?
                .map(|start| (pid, start)),
            None => None,
        };
        let checkpoint_store = checkpoints::CheckpointStore::new(&config.data_root, &project)?;
        let mut runtime = Self {
            checkpoints: checkpoint_store,
            checkpoint_ready: helper.is_some(),
            native_process,
            installation: None,
            client: Mutex::new(Some(Arc::new(client))),
            session_id,
            project_root: project.to_string_lossy().into_owned(),
            library_path: config
                .library_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            outputs: outputs::OutputStore::open(&config.data_root, &project.to_string_lossy())?,
            resources: Mutex::new((sysinfo::System::new(), false)),
            data_root,
            timeout: config.execution_timeout,
            input: Mutex::new(None),
            input_changed: watch::channel(0).0,
            closing: std::sync::atomic::AtomicBool::new(false),
        };
        let library_setup = match &config.library_path {
            Some(library) => format!(
                ".libPaths(c({}, .Library), include.site = FALSE);",
                quote(&library.to_string_lossy())?
            ),
            None => String::new(),
        };
        let helper_setup = helper.as_ref().map(|path| {
            let manifest_path=path.parent().unwrap().join("manifest.json");
            format!("m <- jsonlite::fromJSON({}); if (!identical(as.character(getRversion()),m$r_version) || !identical(R.version$platform,m$platform)) stop('Checkpoint native provider ABI differs'); e$rho_checkpoint_initialize({});",quote(&manifest_path.to_string_lossy()).unwrap(),quote(&path.to_string_lossy()).unwrap())
        }).unwrap_or_default();
        let handshake = runtime.data_root.join("installation-handshake.json");
        let handshake_code = format!(
            "jsonlite::write_json(list(r_home=normalizePath(R.home(),winslash='/',mustWork=TRUE),r_version=as.character(getRversion()),platform=R.version$platform),{},auto_unbox=TRUE);",
            quote(&handshake.to_string_lossy())?
        );
        let viewer_pending = runtime.data_root.join("viewer-pending");
        let bootstrap = format!(
            "local({{ requireNamespace('jsonlite'); requireNamespace('tools'); e <- new.env(parent = asNamespace('utils')); e$can_inspect_bindings <- requireNamespace('rlang', quietly=TRUE); eval(parse(text = {}), e); options(rho.next.bridge = e, viewer = e$rho_viewer({})); setwd({}); {library_setup} {helper_setup} {handshake_code} invisible(TRUE) }})",
            quote(&format!(
                "{BRIDGE}\n{QUERIES}\n{PACKAGES}\n{OBJECTS}\n{PACKAGE_INDEX}\n{TOOLS}\n{CHECKPOINTS}"
            ))?,
            quote(&viewer_pending.to_string_lossy())?,
            quote(&project.to_string_lossy())?
        );
        let bootstrap_output = runtime
            .evaluate(bootstrap, watch::channel(false).1, None, None)
            .await
            .map_err(|e| e.message)?;
        if let Some(error) = bootstrap_output.protocol_error {
            return Err(format!("Ark bridge initialization failed: {error}"));
        }
        let bytes = std::fs::read(&handshake).map_err(|e| e.to_string())?;
        if bytes.len() > 8192 {
            return Err("Native R installation handshake exceeded limit".into());
        }
        let installation: rho_r_api::RuntimeInstallationIdentity =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if Path::new(&installation.r_home)
            .canonicalize()
            .map_err(|e| e.to_string())?
            != config.r_home.canonicalize().map_err(|e| e.to_string())?
        {
            return Err("Ark loaded a different R installation from its launch binding".into());
        }
        runtime.installation = Some(installation);
        Ok(runtime)
    }

    pub fn child_pid(&self) -> Option<u32> {
        self.client.lock().ok()?.as_ref()?.child_pid()
    }

    fn client(&self) -> Result<Arc<Client>, NativeError> {
        let client = self
            .client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| {
                NativeError::before_effect("Ark session is unavailable; start a new host")
            })?;
        if *client.watch_status().borrow() == KernelStatus::Exited {
            self.invalidate();
            return Err(NativeError::before_effect(
                "Ark kernel has exited; start a new session",
            ));
        }
        Ok(client)
    }

    fn transport_error(
        &self,
        operation_id: Option<&rho_r_api::OperationId>,
        request_id: Option<&str>,
        detail: String,
        result_path: Option<&Path>,
    ) -> NativeError {
        self.invalidate();
        let recovery = json!({
            "session_id": self.session_id,
            "operation_id": operation_id,
            "request_id": request_id,
            "failure": detail,
            "result_path": result_path,
            "action": "observe_owner_before_any_retry"
        });
        match operation_id {
            Some(_) => NativeError::after_possible_effect(RUN_CONNECTION_LOST, Some(recovery)),
            None => NativeError::query_error(
                "unavailable",
                "The R session became unavailable while refreshing this read-only query; refresh after reconnecting.",
            ),
        }
    }

    fn evaluation_client(
        &self,
        operation_id: Option<&rho_r_api::OperationId>,
        result_path: Option<&Path>,
    ) -> Result<Arc<Client>, NativeError> {
        self.client()
            .map_err(|error| self.transport_error(operation_id, None, error.message, result_path))
    }

    fn invalidate(&self) {
        self.input.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.client.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    async fn evaluate(
        &self,
        code: String,
        mut cancellation: watch::Receiver<bool>,
        operation_id: Option<&rho_r_api::OperationId>,
        result_path: Option<&Path>,
    ) -> Result<CapturedOutput, NativeError> {
        let mut writer = operation_id
            .map(|id| self.outputs.begin(id))
            .transpose()
            .map_err(before)?;
        let client = self.evaluation_client(operation_id, result_path)?;
        let mut listener = client.listen(ListenFilter::default());
        let message: JupyterMessage = ExecuteRequest {
            code,
            silent: false,
            store_history: false,
            user_expressions: None,
            allow_stdin: operation_id.is_some(),
            stop_on_error: true,
        }
        .into();
        let request_id = message.header.msg_id.clone();
        let stream = client.request(message).map_err(|error| {
            self.transport_error(
                operation_id,
                Some(&request_id),
                error.to_string(),
                result_path,
            )
        })?;
        drop(stream);
        let mut captured = CapturedOutput::default();
        let mut idle = false;
        let mut reply = false;
        let mut cancellation_open = true;
        let mut interrupted = false;
        let mut deadline = Instant::now() + self.timeout;
        let mut input_changed = self.input_changed.subscribe();
        let mut waiting_input = false;
        let mut interrupt_deadline = deadline + Duration::from_secs(5);
        loop {
            let bridge_failed = result_path.is_some_and(|path| {
                read_bridge_response(path, &request_id, 128 * 1024 * 1024).is_ok_and(|response| {
                    matches!(
                        response.outcome,
                        OperationOutcome::Failed | OperationOutcome::Cancelled
                    )
                })
            });
            if bridge_failed {
                self.input.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(writer) = &mut writer
                    && let Err(error) = writer.finish()
                {
                    captured.observation_error = Some(error);
                }
                return Ok(captured);
            }
            if waiting_input {
                let mut input = self.input.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(active) = input.as_mut()
                    && let Some(at) = active.submitted_at.take()
                {
                    deadline += at.duration_since(active.started);
                    waiting_input = false;
                    if let Some(echo) = active.echo.take()
                        && let Some(writer) = &mut writer
                    {
                        let _ = writer.stream("stdout", &format!("{echo}\n"));
                    }
                }
            }
            if waiting_input
                && !interrupted
                && self.closing.load(std::sync::atomic::Ordering::Acquire)
            {
                client.interrupt().await.map_err(|e| {
                    self.transport_error(
                        operation_id,
                        Some(&request_id),
                        e.to_string(),
                        result_path,
                    )
                })?;
                interrupted = true;
                interrupt_deadline = Instant::now() + Duration::from_secs(5);
            }
            tokio::select! {
                biased;
                frame = tokio::time::timeout(Duration::from_millis(100), listener.recv()) => {
                    let frame = match frame {
                        Ok(Some(frame)) => frame,
                        Ok(None) => break,
                        Err(_) => continue,
                    };
                    if frame.message.parent_header.as_ref().map(|h| h.msg_id.as_str()) != Some(request_id.as_str()) {
                        continue;
                    }
                    if self.input.lock().unwrap_or_else(|e|e.into_inner()).as_ref().is_some_and(|i|i.public.submitted) && !waiting_input { self.input.lock().unwrap_or_else(|e|e.into_inner()).take(); }
                    let input_message = if matches!(&frame.message.content, JupyterMessageContent::InputRequest(_)) { Some(frame.message.clone()) } else { None };
                    match frame.message.content {
                        JupyterMessageContent::InputRequest(input) => {
                            if let Some(id)=operation_id {
                                *self.input.lock().unwrap_or_else(|e|e.into_inner())=Some(ActiveInput {
                                    public:rho_r_api::InputRequest{session_id:self.session_id.clone(),operation_id:id.clone(),request_id:frame.message.header.msg_id.clone(),prompt:input.prompt.chars().take(8192).collect(),password:input.password,submitted:false},
                                    message:input_message.unwrap(),started:Instant::now(),submitted_at:None,echo:None,
                                });
                                waiting_input=true;
                            }
                        }
                        JupyterMessageContent::Status(status) => { idle |= status.execution_state == ExecutionState::Idle; }
                        JupyterMessageContent::ExecuteReply(result) => {
                            reply = true;
                            let value = serde_json::to_value(result).unwrap_or(Value::Null);
                            if value["status"] != "ok" {
                                captured.protocol_error = Some(value);
                                self.input.lock().unwrap_or_else(|e| e.into_inner()).take();
                                if let Some(writer) = &mut writer
                                    && let Err(error) = writer.finish()
                                {
                                    captured.observation_error = Some(error);
                                }
                                return Ok(captured);
                            }
                        }
                        JupyterMessageContent::StreamContent(stream) => {
                            if let Some(writer) = &mut writer
                                && let Err(error) = writer.stream(match stream.name { Stdio::Stdout => "stdout", Stdio::Stderr => "stderr" }, &stream.text) { captured.observation_error = Some(error); }
                            let output = match stream.name {
                                Stdio::Stdout => &mut captured.stdout,
                                Stdio::Stderr => &mut captured.stderr,
                            };
                            push_bounded(output, &stream.text, &mut captured.truncated);
                        }
                        JupyterMessageContent::DisplayData(display) => {
                            let value = serde_json::to_value(display).unwrap_or(Value::Null);
                            if let Some(writer) = &mut writer {
                                match writer.display(&value) {
                                    Ok(Some(reference)) => captured.displays.push(reference),
                                    Ok(None) => {},
                                    Err(error) => { captured.observation_error = Some(error); },
                                }
                            }
                        }

                        JupyterMessageContent::ExecuteResult(display) => {
                            let value = serde_json::to_value(display).unwrap_or(Value::Null);
                            if let Some(writer) = &mut writer {
                                match writer.display(&value) {
                                    Ok(Some(reference)) => captured.displays.push(reference),
                                    Ok(None) => {},
                                    Err(error) => { captured.observation_error = Some(error); },
                                }
                            }
                        }

                        JupyterMessageContent::UpdateDisplayData(display) => {
                            let value = serde_json::to_value(display).unwrap_or(Value::Null);
                            if let Some(writer) = &mut writer {
                                match writer.display(&value) {
                                    Ok(Some(reference)) => captured.displays.push(reference),
                                    Ok(None) => {},
                                    Err(error) => { captured.observation_error = Some(error); },
                                }
                            }
                        }

                        _ => {}
                    }
                    let bridge_failed = result_path.is_some_and(|path| {
                        read_bridge_response(path, &request_id, 128 * 1024 * 1024).is_ok_and(|response| {
                            matches!(response.outcome, OperationOutcome::Failed | OperationOutcome::Cancelled)
                        })
                    });
                    if (idle && reply) || bridge_failed {
                        self.input.lock().unwrap_or_else(|e| e.into_inner()).take();
                        if let Some(writer) = &mut writer && let Err(error) = writer.finish() { captured.observation_error = Some(error); }
                        return Ok(captured);
                    }
                }
                _ = input_changed.changed(), if waiting_input => {}
                change = cancellation.changed(), if cancellation_open && !interrupted => {
                    if change.is_err() { cancellation_open = false; }
                    else if *cancellation.borrow() {
                        client.interrupt().await.map_err(|error| self.transport_error(operation_id, Some(&request_id), error.to_string(), result_path))?;
                        interrupted = true;
                        interrupt_deadline = Instant::now() + Duration::from_secs(5);
                    }
                }
                _ = tokio::time::sleep_until(deadline), if !interrupted && !waiting_input => {
                    client.interrupt().await.map_err(|error| self.transport_error(operation_id, Some(&request_id), error.to_string(), result_path))?;
                    interrupted = true;
                    interrupt_deadline = Instant::now() + Duration::from_secs(5);
                }
                _ = tokio::time::sleep_until(interrupt_deadline), if interrupted => { break; }
            }
        }
        Err(self.transport_error(
            operation_id,
            Some(&request_id),
            "Ark stopped responding before both execute_reply and idle were observed".into(),
            result_path,
        ))
    }
}

#[derive(Default)]
struct CapturedOutput {
    stdout: String,
    stderr: String,
    truncated: bool,
    displays: Vec<rho_r_api::MediaReference>,
    observation_error: Option<String>,
    protocol_error: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeResponse {
    protocol_version: u16,
    request_id: String,
    outcome: OperationOutcome,
    error: Option<String>,
    value: Value,
    conditions: Vec<rho_r_api::WorkspaceCondition>,
    conditions_truncated: bool,
}

enum BridgeReadError {
    Missing,
    Io,
    TooLarge,
    Malformed,
    Correlation,
}

impl BridgeReadError {
    fn kind(&self) -> &'static str {
        match self {
            Self::Missing => "missing_result",
            Self::Io => "result_read_failed",
            Self::TooLarge => "result_too_large",
            Self::Malformed => "malformed_result",
            Self::Correlation => "correlation_mismatch",
        }
    }
}

fn read_bridge_response(
    result_path: &Path,
    request_id: &str,
    response_limit: usize,
) -> Result<BridgeResponse, BridgeReadError> {
    let file = std::fs::File::open(result_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            BridgeReadError::Missing
        } else {
            BridgeReadError::Io
        }
    })?;
    let mut bytes = Vec::new();
    file.take((response_limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| BridgeReadError::Io)?;
    if bytes.len() > response_limit {
        return Err(BridgeReadError::TooLarge);
    }
    let response: BridgeResponse =
        serde_json::from_slice(&bytes).map_err(|_| BridgeReadError::Malformed)?;
    if response.protocol_version != 1 || response.request_id != request_id {
        return Err(BridgeReadError::Correlation);
    }
    Ok(response)
}

#[derive(Serialize)]
#[serde(tag = "action", content = "payload", rename_all = "snake_case")]
enum BridgeAction<'a> {
    CheckpointCapture(&'a Value),
    CheckpointRestore(&'a Value),
    Execute(&'a RunRArguments),
    Snapshot(&'a SnapshotArguments),
    Packages(&'a rho_r_api::PackageQueryArguments),
    InspectObject(&'a InspectArguments),
    ListObjects(&'a rho_r_api::ScopedWorkspaceArguments<rho_r_api::ListObjectsArguments>),
    ObserveObject(&'a rho_r_api::ScopedWorkspaceArguments<rho_r_api::ObserveObjectArguments>),
    ReadObject(&'a rho_r_api::ScopedWorkspaceArguments<rho_r_api::ReadObjectArguments>),
    PackageIndex(&'a rho_r_api::ScopedWorkspaceArguments<rho_r_api::PackageIndexArguments>),
    ReadHelp(&'a rho_r_api::ScopedWorkspaceArguments<rho_r_api::ReadPackageHelpArguments>),
    Help(&'a HelpArguments),
    Lint(&'a LintArguments),
    Format(&'a FormatArguments),
}

#[derive(Serialize)]
struct BridgeRequest<'a> {
    protocol_version: u16,
    request_id: &'a str,
    #[serde(flatten)]
    action: BridgeAction<'a>,
}

#[async_trait]
impl NativeRuntime for ArkRuntime {
    fn checkpoint_available(&self) -> bool {
        self.checkpoint_ready
    }
    fn process_identity(&self) -> Option<rho_r_api::RuntimeProcessIdentity> {
        self.native_process
            .map(|(pid, start_time)| rho_r_api::RuntimeProcessIdentity {
                native_session_id: self.session_id.clone(),
                pid,
                start_time,
            })
    }
    fn installation_identity(&self) -> Option<rho_r_api::RuntimeInstallationIdentity> {
        self.installation.clone()
    }
    async fn shutdown(&self) -> Result<(), NativeError> {
        self.shutdown_confirmed().await
    }
    async fn native_process_alive(&self) -> Result<Option<bool>, NativeError> {
        let Some((pid, start)) = self.native_process else {
            return Ok(None);
        };
        Ok(Some(checkpoints::process_start(pid).await? == Some(start)))
    }
    async fn checkpoint_capture(
        &self,
        op: &OperationId,
        args: &rho_r_api::CheckpointCaptureArguments,
        cancel: watch::Receiver<bool>,
    ) -> Result<rho_r_api::CheckpointArtifact, NativeError> {
        self.capture_checkpoint(op, args, cancel).await
    }
    async fn checkpoint_artifact_lease(
        &self,
        id: &rho_r_api::OperationId,
    ) -> Result<Box<dyn rho_r_api::CheckpointArtifactLease>, NativeError> {
        Ok(self.checkpoints.artifact_lease(id).await)
    }
    async fn checkpoint_original_manifest(
        &self,
        id: &rho_r_api::OperationId,
    ) -> Result<Option<rho_r_api::CheckpointManifest>, NativeError> {
        self.checkpoints.original_manifest(id).map_err(before)
    }
    async fn checkpoint_adopt(
        &self,
        source: &rho_r_api::CheckpointManifest,
        adopted: &rho_r_api::CheckpointManifest,
    ) -> Result<(), NativeError> {
        let store = self.checkpoints.clone();
        let source = source.clone();
        let adopted = adopted.clone();
        tokio::task::spawn_blocking(move || store.adopt(&source, &adopted))
            .await
            .map_err(before)?
            .map_err(before)
    }
    async fn checkpoint_publish(
        &self,
        manifest: &rho_r_api::CheckpointManifest,
    ) -> Result<(), NativeError> {
        self.publish_checkpoint(manifest)
    }
    async fn checkpoint_candidates(
        &self,
    ) -> Result<Vec<rho_r_api::CheckpointManifest>, NativeError> {
        let store = self.checkpoints.clone();
        tokio::task::spawn_blocking(move || store.candidates())
            .await
            .map_err(before)?
            .map_err(before)
    }
    async fn checkpoint_control_evidence(
        &self,
        id: &rho_r_api::OperationId,
    ) -> Result<Vec<rho_r_api::CheckpointControlEvidence>, NativeError> {
        self.checkpoints.controls(id).map_err(before)
    }
    async fn checkpoint_write_control(
        &self,
        evidence: &rho_r_api::CheckpointControlEvidence,
    ) -> Result<(), NativeError> {
        self.write_checkpoint_control(evidence)
    }
    fn checkpoint_remove_payload(&self, id: &rho_r_api::OperationId) -> Result<(), String> {
        self.remove_checkpoint_payload(id)
    }
    async fn checkpoint_present(
        &self,
        manifest: &rho_r_api::CheckpointManifest,
    ) -> Result<bool, NativeError> {
        self.checkpoints.present(manifest).map_err(before)
    }
    async fn checkpoint_verify(
        &self,
        manifest: &rho_r_api::CheckpointManifest,
    ) -> Result<bool, NativeError> {
        let store = self.checkpoints.clone();
        let manifest = manifest.clone();
        tokio::task::spawn_blocking(move || store.verify(&manifest))
            .await
            .map_err(before)?
            .map_err(before)
    }
    async fn checkpoint_restore(
        &self,
        op: &OperationId,
        manifest: &rho_r_api::CheckpointManifest,
        cancel: watch::Receiver<bool>,
    ) -> Result<rho_r_api::CheckpointNativeRestoreReport, NativeError> {
        self.restore_checkpoint(op, manifest, cancel).await
    }

    fn begin_shutdown(&self) {
        self.closing
            .store(true, std::sync::atomic::Ordering::Release);
        self.input_changed.send_modify(|v| *v = v.wrapping_add(1));
    }
    fn input_request(&self) -> Option<rho_r_api::InputRequest> {
        self.input
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|i| i.public.clone())
    }
    fn respond_input(&self, reply: rho_r_api::RespondInput) -> Result<(), String> {
        if reply.value.len() > 65536
            || reply.value.contains('\0')
            || reply.reply_id.is_empty()
            || reply.reply_id.len() > 160
        {
            return Err("Invalid input response bounds".into());
        }
        let client = self.client().map_err(|e| e.message)?;
        let mut input = self.input.lock().unwrap_or_else(|e| e.into_inner());
        let active = input
            .as_mut()
            .ok_or("This input request is no longer pending")?;
        if active.public.session_id != reply.session_id
            || active.public.operation_id != reply.operation_id
            || active.public.request_id != reply.request_id
            || active.public.submitted
        {
            return Err("Input identity changed or an answer was already submitted".into());
        }
        let mut message: JupyterMessage = InputReply {
            value: reply.value.clone(),
            ..Default::default()
        }
        .into();
        message.parent_header = Some(active.message.header.clone());
        client
            .reply_stdin(message)
            .map_err(|_| "Input transport is unavailable".to_string())?;
        active.public.submitted = true;
        active.submitted_at = Some(Instant::now());
        if !active.public.password {
            active.echo = Some(reply.value);
        }
        self.input_changed.send_modify(|v| *v = v.wrapping_add(1));
        Ok(())
    }
    async fn check_code(&self, code: &str) -> Result<rho_r_api::CodeCompleteness, String> {
        let client = self.client().map_err(|e| e.message)?;
        if *client.watch_status().borrow() != KernelStatus::Idle {
            return Err("R is busy".into());
        }
        let mut stream = client
            .request(IsCompleteRequest { code: code.into() }.into())
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(frame) = stream.recv().await {
                if let JupyterMessageContent::IsCompleteReply(reply) = frame.message.content {
                    let value = serde_json::to_value(reply).map_err(|e| e.to_string())?;
                    return Ok(rho_r_api::CodeCompleteness {
                        status: value["status"].as_str().unwrap_or("unknown").into(),
                        indent: value["indent"].as_str().unwrap_or("").into(),
                    });
                }
            }
            Err("No R completeness reply".into())
        })
        .await
        .map_err(|_| "R completeness timed out".to_string())?
    }
    async fn output_events(
        &self,
        args: &rho_r_api::OutputEventsArguments,
    ) -> Result<rho_r_api::OutputEvents, String> {
        self.outputs.events(args)
    }
    async fn read_output(
        &self,
        args: &rho_r_api::ReadOutputArguments,
    ) -> Result<rho_r_api::OutputPage, String> {
        self.outputs.read(args)
    }
    fn execution_state(&self) -> String {
        let client = self.client.lock().unwrap_or_else(|e| e.into_inner());
        match client.as_ref() {
            None => "unavailable",
            Some(client) => match *client.watch_status().borrow() {
                KernelStatus::Starting => "starting",
                KernelStatus::Idle => "idle",
                KernelStatus::Busy => "busy",
                KernelStatus::Exited => "unavailable",
            },
        }
        .into()
    }
    fn runtime_status(&self) -> rho_r_api::RuntimeStatus {
        let (state, pid) = match self.client() {
            Ok(client) => (
                match *client.watch_status().borrow() {
                    KernelStatus::Starting => "starting",
                    KernelStatus::Idle => "idle",
                    KernelStatus::Busy => "busy",
                    KernelStatus::Exited => "unavailable",
                },
                client.child_pid(),
            ),
            Err(_) => ("unavailable", None),
        };
        let mut processes = Vec::new();
        if let Some(pid) = pid {
            let mut resources = self.resources.lock().unwrap_or_else(|e| e.into_inner());
            let sampled = resources.1;
            resources.0.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
                true,
                sysinfo::ProcessRefreshKind::nothing()
                    .with_memory()
                    .with_cpu(),
            );
            if let Some(process) = resources.0.process(sysinfo::Pid::from_u32(pid)) {
                processes.push(rho_r_api::ProcessObservation {
                    pid,
                    role: "Ark/R".into(),
                    memory_bytes: Some(process.memory()),
                    cpu_percent: sampled.then(|| process.cpu_usage()),
                });
            }
            resources.1 = true;
        }
        rho_r_api::RuntimeStatus {session_id:self.session_id.clone(),state:state.into(),observed_at_ms:now_ms(),processes,notices:vec!["Resource observations cover the known Ark process, which embeds R; unrelated child processes are not included.".into()]}
    }

    fn project_root(&self) -> Option<&str> {
        Some(&self.project_root)
    }
    fn session_id(&self) -> &str {
        &self.session_id
    }

    async fn query(&self, query: &WorkspaceQuery) -> Result<NativeObservation, NativeError> {
        let id = format!("query_{}", Uuid::new_v4().simple());
        let action = match query {
            WorkspaceQuery::Snapshot(args) => BridgeAction::Snapshot(args),
            WorkspaceQuery::Packages(args) => BridgeAction::Packages(args),
            WorkspaceQuery::InspectObject(args) => BridgeAction::InspectObject(args),
            WorkspaceQuery::ListObjects(args) => BridgeAction::ListObjects(args),
            WorkspaceQuery::ObserveObject(args) => BridgeAction::ObserveObject(args),
            WorkspaceQuery::ReadObject(args) => BridgeAction::ReadObject(args),
            WorkspaceQuery::PackageIndex(args) => BridgeAction::PackageIndex(args),
            WorkspaceQuery::ReadHelp(args) => BridgeAction::ReadHelp(args),
        };
        let (response, _, result_path) = self
            .bridge_call(&id, action, watch::channel(false).1)
            .await?;
        // Query transport files are temporary; no Operation or retained query history.
        let _ = std::fs::remove_file(result_path);
        if response.outcome != OperationOutcome::Succeeded {
            let failure = &response.value["query_error"];
            return Err(NativeError::query_error(
                failure["code"].as_str().unwrap_or("unavailable"),
                failure["message"]
                    .as_str()
                    .unwrap_or("Native Workspace query failed"),
            ));
        }
        let data = match query {
            WorkspaceQuery::ListObjects(_) => serde_json::to_value(
                serde_json::from_value::<rho_r_api::ObjectDirectoryPage>(response.value)
                    .map_err(before)?,
            )
            .map_err(before)?,
            WorkspaceQuery::ObserveObject(_) => serde_json::to_value(
                serde_json::from_value::<rho_r_api::ObjectObservation>(response.value)
                    .map_err(before)?,
            )
            .map_err(before)?,
            WorkspaceQuery::ReadObject(_) => serde_json::to_value(
                serde_json::from_value::<rho_r_api::ObjectReadPage>(response.value)
                    .map_err(before)?,
            )
            .map_err(before)?,
            WorkspaceQuery::PackageIndex(_) => serde_json::to_value(
                serde_json::from_value::<rho_r_api::PackageIndexPage>(response.value)
                    .map_err(before)?,
            )
            .map_err(before)?,
            WorkspaceQuery::ReadHelp(_) => serde_json::to_value(
                serde_json::from_value::<rho_r_api::PackageHelpPage>(response.value)
                    .map_err(before)?,
            )
            .map_err(before)?,
            WorkspaceQuery::Packages(_) => {
                let data: rho_r_api::PackageSnapshotData =
                    serde_json::from_value(response.value).map_err(before)?;
                serde_json::to_value(data).map_err(before)?
            }

            WorkspaceQuery::Snapshot(_) => {
                let data: WorkspaceSnapshotData =
                    serde_json::from_value(response.value).map_err(before)?;
                serde_json::to_value(data).map_err(before)?
            }
            WorkspaceQuery::InspectObject(_) => {
                let data: BindingSummary =
                    serde_json::from_value(response.value).map_err(before)?;
                serde_json::to_value(data).map_err(before)?
            }
        };
        let observed_at_ms = data
            .get("observed_at_ms")
            .and_then(Value::as_i64)
            .filter(|ms| *ms > 0)
            .unwrap_or_else(now_ms);
        Ok(NativeObservation {
            session_id: self.session_id.clone(),
            source: "ark/rho.bridge".into(),
            observed_at_ms,
            completeness: if data.get("complete").and_then(Value::as_bool) == Some(true) {
                NativeCompleteness::Complete
            } else {
                NativeCompleteness::Partial
            },
            data,
            notices: if matches!(query, WorkspaceQuery::Packages(_)) {
                vec!["Read-only package metadata from the current session; loadability was not tested.".into()]
            } else {
                vec!["Bounded live observation; lazy/active bindings and classed values are not evaluated.".into()]
            },
        })
    }

    async fn execute(
        &self,
        operation: &OperationId,
        request: &RunRArguments,
    ) -> Result<NativeReport, NativeError> {
        self.execute_controlled(operation, request, watch::channel(false).1)
            .await
    }

    async fn execute_controlled(
        &self,
        operation: &OperationId,
        request: &RunRArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<NativeReport, NativeError> {
        self.execute_action(
            operation,
            BridgeAction::Execute(request),
            "execute",
            cancellation,
        )
        .await
    }

    async fn execute_tool_controlled(
        &self,
        operation: &OperationId,
        request: &WorkspaceToolRequest,
        cancellation: watch::Receiver<bool>,
    ) -> Result<NativeReport, NativeError> {
        let action = match request {
            WorkspaceToolRequest::Help(args) => BridgeAction::Help(args),
            WorkspaceToolRequest::Lint(args) => BridgeAction::Lint(args),
            WorkspaceToolRequest::Format(args) => BridgeAction::Format(args),
        };
        self.execute_action(operation, action, request.action(), cancellation)
            .await
    }
}

impl ArkRuntime {
    /// Retain viewer documents written during a run, oldest first. Files that
    /// cannot be retained stay on disk with the error rather than being dropped.
    fn drain_viewer(
        &self,
        id: &rho_r_api::OperationId,
    ) -> Result<Vec<rho_r_api::MediaReference>, String> {
        let pending = self.data_root.join("viewer-pending");
        let mut names: Vec<_> = match std::fs::read_dir(&pending) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "html"))
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(error.to_string()),
        };
        names.sort();
        let mut references = Vec::new();
        for path in names {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let reference = self.outputs.append_html(id, &bytes)?;
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            references.push(reference);
        }
        Ok(references)
    }

    async fn execute_action(
        &self,
        operation: &OperationId,
        action: BridgeAction<'_>,
        action_name: &str,
        cancellation: watch::Receiver<bool>,
    ) -> Result<NativeReport, NativeError> {
        let (mut response, mut captured, result_path) = self
            .bridge_call(operation.as_str(), action, cancellation)
            .await?;
        if action_name == "execute" {
            // Documents the run handed to the viewer belong to this run: the lane
            // serializes executions, so pending files cannot come from another one.
            match self.drain_viewer(operation) {
                Ok(references) => captured.displays.extend(references),
                Err(error) => {
                    captured.observation_error.get_or_insert(error);
                }
            }
        }
        if action_name == "help"
            && response.outcome == OperationOutcome::Succeeded
            && let Some(text) = response.value.get("text").and_then(Value::as_str)
            && response.value.get("found").and_then(Value::as_bool) == Some(true)
        {
            let reference = self.outputs.append_text(operation, text)
                .map_err(|error| NativeError::after_possible_effect(error,
                    Some(json!({"operation_id":operation, "session_id":self.session_id, "result_path":result_path, "next_read":"workspace.output_events"}))))?;
            captured.displays.push(reference.clone());
            let preview = response
                .value
                .get("preview")
                .cloned()
                .unwrap_or(Value::String(String::new()));
            if let Some(value) = response.value.as_object_mut() {
                value.insert("text".into(), preview);
                value.remove("preview");
                value.insert(
                    "text_reference".into(),
                    serde_json::to_value(reference).map_err(before)?,
                );
            }
        }
        let observed_at_ms = now_ms();
        Ok(NativeReport {
            session_id: self.session_id.clone(),
            value: response.value,
            stdout: captured.stdout,
            stderr: captured.stderr,
            conditions: {
                let mut conditions = response.conditions;
                if let Some(error) = &captured.observation_error {
                    conditions.push(rho_r_api::WorkspaceCondition {
                        kind: "output_observation".into(),
                        message: format!("Output observation is incomplete: {error}"),
                    });
                }
                conditions
            },
            output_references: captured.displays,
            effect_observations: vec![NativeEffect {
                kind: "r_execution".into(),
                source: "ark".into(),
                detail: json!({"child_pid":self.child_pid(), "outcome":response.outcome,
                    "environment_library":self.library_path, "action":action_name,
                    "output_truncated":captured.truncated || response.conditions_truncated,
                    "output_observation_error":captured.observation_error,
                    "containment":"native_user_process", "result_path":result_path}),
                observed_at_ms,
                completeness: NativeCompleteness::Partial,
            }],
            outcome: response.outcome,
            error: response.error,
        })
    }
}

impl ArkRuntime {
    fn bridge_error(
        &self,
        operation_id: &str,
        readonly: bool,
        kind: &str,
        detail: Option<Value>,
        result_path: &Path,
    ) -> NativeError {
        self.invalidate();
        if readonly {
            return NativeError::query_error(
                "unavailable",
                "The R session became unavailable while refreshing this read-only query; refresh after reconnecting.",
            );
        }
        NativeError::after_possible_effect(
            RUN_CONNECTION_LOST,
            Some(json!({
                "session_id": self.session_id,
                "operation_id": operation_id,
                "request_id": operation_id,
                "result_path": result_path,
                "failure_kind": kind,
                "detail": detail,
                "action": "observe_owner_before_any_retry"
            })),
        )
    }

    async fn bridge_call(
        &self,
        id: &str,
        action: BridgeAction<'_>,
        cancellation: watch::Receiver<bool>,
    ) -> Result<(BridgeResponse, CapturedOutput, PathBuf), NativeError> {
        let result_path = self
            .data_root
            .join(format!("{:x}.json", Sha256::digest(id.as_bytes())));
        // Help is rendered once into a bounded artifact; its internal JSON can escape UTF-8 bytes.
        let response_limit = if matches!(&action, BridgeAction::Help(_)) {
            128 * 1024 * 1024
        } else {
            OUTPUT_LIMIT
        };
        let recording = match &action {
            BridgeAction::Snapshot(_)
            | BridgeAction::InspectObject(_)
            | BridgeAction::Packages(_)
            | BridgeAction::ListObjects(_)
            | BridgeAction::ObserveObject(_)
            | BridgeAction::ReadObject(_)
            | BridgeAction::PackageIndex(_) => None,
            BridgeAction::ReadHelp(_) => None,
            _ => Some(rho_r_api::OperationId::new(id).map_err(before)?),
        };
        let bridge_request = BridgeRequest {
            protocol_version: 1,
            request_id: id,
            action,
        };
        let request_json = serde_json::to_string(&bridge_request).map_err(before)?;
        let code = if recording.is_none() {
            readonly_bridge_code(id, &request_json, &result_path).map_err(before)?
        } else {
            format!(
                "local({{ request <- jsonlite::fromJSON({}, simplifyVector = FALSE); response <- getOption('rho.next.bridge')$rho_dispatch(request); jsonlite::write_json(response, {}, auto_unbox = TRUE, null = 'null', digits = NA); invisible(NULL) }})",
                quote(&request_json).map_err(before)?,
                quote(&result_path.to_string_lossy()).map_err(before)?
            )
        };
        let readonly = recording.is_none();
        let captured = self
            .evaluate(code, cancellation, recording.as_ref(), Some(&result_path))
            .await?;
        if let Some(error) = captured.protocol_error.clone() {
            match read_bridge_response(&result_path, id, response_limit) {
                Ok(response) => return Ok((response, captured, result_path)),
                Err(confirmation) => {
                    return Err(self.bridge_error(
                        id,
                        readonly,
                        "protocol_error",
                        Some(json!({
                            "kernel_error": error,
                            "result_confirmation": confirmation.kind(),
                        })),
                        &result_path,
                    ));
                }
            }
        }
        let response = read_bridge_response(&result_path, id, response_limit)
            .map_err(|error| self.bridge_error(id, readonly, error.kind(), None, &result_path))?;
        Ok((response, captured, result_path))
    }
}

/// The read transport must not reload its own serializer after explicit user unload.
/// A pre-encoded response can report unavailability without needing that provider.
fn readonly_bridge_code(
    id: &str,
    request_json: &str,
    result_path: &Path,
) -> Result<String, String> {
    let message = "jsonlite is not loaded or its transport bindings are unavailable in this native session; read-only queries do not load providers.";
    let unavailable=serde_json::to_string(&json!({"protocol_version":1,"request_id":id,"outcome":"failed","error":message,"value":{"query_error":{"code":"unavailable","message":message}},"conditions":[],"conditions_truncated":false})).map_err(|e|e.to_string())?;
    Ok(format!(
        "base::getOption('rho.next.bridge')$rho_query_json({}, {}, {})",
        quote(request_json)?,
        quote(&result_path.to_string_lossy())?,
        quote(&unavailable)?
    ))
}

fn quote(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn before(error: impl std::fmt::Display) -> NativeError {
    NativeError::before_effect(error.to_string())
}
fn push_bounded(output: &mut String, incoming: &str, truncated: &mut bool) {
    let remaining = OUTPUT_LIMIT.saturating_sub(output.len());
    let mut end = remaining.min(incoming.len());
    while !incoming.is_char_boundary(end) {
        end -= 1;
    }
    output.push_str(&incoming[..end]);
    *truncated |= end < incoming.len();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_bridge_result_is_a_typed_transport_failure() {
        let temp = tempfile::tempdir().unwrap();
        let error =
            read_bridge_response(&temp.path().join("missing.json"), "request", OUTPUT_LIMIT)
                .unwrap_err();
        assert!(matches!(error, BridgeReadError::Missing));
        assert_eq!(error.kind(), "missing_result");
    }

    #[test]
    fn malformed_bridge_result_is_not_exposed_as_json_parser_detail() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("response.json");
        std::fs::write(&path, b"{not-json").unwrap();
        let error = read_bridge_response(&path, "request", OUTPUT_LIMIT).unwrap_err();
        assert!(matches!(error, BridgeReadError::Malformed));
        assert_eq!(error.kind(), "malformed_result");
    }

    #[test]
    fn bridge_result_confirmation_rejects_oversized_and_mismatched_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("response.json");
        let response = json!({
            "protocol_version": 1,
            "request_id": "other",
            "outcome": "succeeded",
            "error": null,
            "value": null,
            "conditions": [],
            "conditions_truncated": false
        });
        std::fs::write(&path, serde_json::to_vec(&response).unwrap()).unwrap();
        let error = read_bridge_response(&path, "request", OUTPUT_LIMIT).unwrap_err();
        assert!(matches!(error, BridgeReadError::Correlation));
        assert_eq!(error.kind(), "correlation_mismatch");
        let bytes = serde_json::to_vec(&response).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let error = read_bridge_response(&path, "other", bytes.len() - 1).unwrap_err();
        assert!(matches!(error, BridgeReadError::TooLarge));
        assert_eq!(error.kind(), "result_too_large");
    }

    #[test]
    fn effectful_connection_loss_uses_the_friendly_message() {
        assert_eq!(
            RUN_CONNECTION_LOST,
            "R session connection was lost. The run result is not confirmed. Inspect the original run before retrying."
        );
    }
}
