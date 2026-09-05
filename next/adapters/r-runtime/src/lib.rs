#![forbid(unsafe_code)]

use async_trait::async_trait;
use jet_core::{
    client::{Client, KernelStatus, ListenFilter},
    jupyter_protocol::{
        ExecuteRequest, ExecutionState, JupyterMessage, JupyterMessageContent, Stdio,
    },
    kernel_spec::{InterruptMode, KernelSpec},
};
use rho_next_contract::{EffectObservation, ObservationCompleteness, Operation, OperationOutcome};
use rho_next_workspace::{
    BindingSummary, InspectArguments, RunRArguments, SnapshotArguments, WorkspaceObservation,
    WorkspaceQuery, WorkspaceRuntime, WorkspaceRuntimeError, WorkspaceRuntimeReport,
    WorkspaceSnapshotData,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::watch, time::Instant};
use uuid::Uuid;

const BRIDGE: &str = include_str!("../../../r/bridge/dispatch.R");
const QUERIES: &str = include_str!("../../../r/bridge/query.R");
const OUTPUT_LIMIT: usize = 1024 * 1024;

pub struct ArkConfig {
    pub executable: PathBuf,
    pub r_home: PathBuf,
    pub project_root: PathBuf,
    pub data_root: PathBuf,
    pub execution_timeout: Duration,
}

pub struct ArkRuntime {
    client: Mutex<Option<Arc<Client>>>,
    session_id: String,
    data_root: PathBuf,
    timeout: Duration,
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
        let runtime = Self {
            client: Mutex::new(Some(Arc::new(client))),
            session_id,
            data_root,
            timeout: config.execution_timeout,
        };
        let bootstrap = format!(
            "local({{ e <- new.env(parent = asNamespace('utils')); e$can_inspect_bindings <- requireNamespace('rlang', quietly=TRUE); eval(parse(text = {}), e); options(rho.next.bridge = e); setwd({}); invisible(TRUE) }})",
            quote(&format!("{BRIDGE}\n{QUERIES}"))?,
            quote(&project.to_string_lossy())?
        );
        let bootstrap_output = runtime
            .evaluate(bootstrap, watch::channel(false).1)
            .await
            .map_err(|e| e.message)?;
        if let Some(error) = bootstrap_output.protocol_error {
            return Err(format!("Ark bridge initialization failed: {error}"));
        }
        Ok(runtime)
    }

    pub fn child_pid(&self) -> Option<u32> {
        self.client.lock().ok()?.as_ref()?.child_pid()
    }

    fn client(&self) -> Result<Arc<Client>, WorkspaceRuntimeError> {
        let client = self
            .client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| {
                WorkspaceRuntimeError::before_effect("Ark session is unavailable; start a new host")
            })?;
        if *client.watch_status().borrow() == KernelStatus::Exited {
            self.invalidate();
            return Err(WorkspaceRuntimeError::before_effect(
                "Ark kernel has exited; start a new session",
            ));
        }
        Ok(client)
    }

    fn invalidate(&self) {
        self.client.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    async fn evaluate(
        &self,
        code: String,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<CapturedOutput, WorkspaceRuntimeError> {
        let client = self.client()?;
        let mut listener = client.listen(ListenFilter::default());
        let message: JupyterMessage = ExecuteRequest {
            code,
            silent: false,
            store_history: false,
            user_expressions: None,
            allow_stdin: false,
            stop_on_error: true,
        }
        .into();
        let request_id = message.header.msg_id.clone();
        let stream = client.request(message).map_err(|error| {
            WorkspaceRuntimeError::after_possible_effect(error.to_string(), None)
        })?;
        drop(stream);
        let mut captured = CapturedOutput::default();
        let mut idle = false;
        let mut reply = false;
        let mut cancellation_open = true;
        let mut interrupted = false;
        let deadline = Instant::now() + self.timeout;
        let mut interrupt_deadline = deadline + Duration::from_secs(5);
        loop {
            tokio::select! {
                frame = listener.recv() => {
                    let Some(frame) = frame else { break };
                    if frame.message.parent_header.as_ref().map(|h| h.msg_id.as_str()) != Some(request_id.as_str()) {
                        continue;
                    }
                    match frame.message.content {
                        JupyterMessageContent::Status(status) => { idle |= status.execution_state == ExecutionState::Idle; }
                        JupyterMessageContent::ExecuteReply(result) => {
                            reply = true;
                            let value = serde_json::to_value(result).unwrap_or(Value::Null);
                            if value["status"] != "ok" { captured.protocol_error = Some(value); }
                        }
                        JupyterMessageContent::StreamContent(stream) => {
                            let output = match stream.name {
                                Stdio::Stdout => &mut captured.stdout,
                                Stdio::Stderr => &mut captured.stderr,
                            };
                            push_bounded(output, &stream.text, &mut captured.truncated);
                        }
                        JupyterMessageContent::DisplayData(display) => {
                            let value = serde_json::to_value(display).unwrap_or(Value::Null);
                            let size = serde_json::to_vec(&value).map_or(OUTPUT_LIMIT + 1, |v| v.len());
                            if captured.display_bytes + size <= OUTPUT_LIMIT {
                                captured.display_bytes += size;
                                captured.displays.push(value);
                            } else { captured.truncated = true; }
                        }
                        _ => {}
                    }
                    if idle && reply { return Ok(captured); }
                }
                change = cancellation.changed(), if cancellation_open && !interrupted => {
                    if change.is_err() { cancellation_open = false; }
                    else if *cancellation.borrow() {
                        client.interrupt().await.map_err(|error| WorkspaceRuntimeError::after_possible_effect(error.to_string(), None))?;
                        interrupted = true;
                        interrupt_deadline = Instant::now() + Duration::from_secs(5);
                    }
                }
                _ = tokio::time::sleep_until(deadline), if !interrupted => {
                    client.interrupt().await.map_err(|error| WorkspaceRuntimeError::after_possible_effect(error.to_string(), None))?;
                    interrupted = true;
                    interrupt_deadline = Instant::now() + Duration::from_secs(5);
                }
                _ = tokio::time::sleep_until(interrupt_deadline), if interrupted => { break; }
            }
        }
        self.invalidate();
        Err(WorkspaceRuntimeError::after_possible_effect(
            "Ark stopped responding before both execute_reply and idle were observed",
            Some(
                json!({"session_id": self.session_id, "request_id": request_id,
                "action": "session_invalidated_observe_outputs_before_retry"}),
            ),
        ))
    }
}

#[derive(Default)]
struct CapturedOutput {
    stdout: String,
    stderr: String,
    truncated: bool,
    displays: Vec<Value>,
    display_bytes: usize,
    protocol_error: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeResponse {
    protocol_version: u16,
    request_id: String,
    outcome: OperationOutcome,
    error: Option<String>,
    value: Value,
    conditions: Vec<Value>,
    conditions_truncated: bool,
}

#[derive(Serialize)]
#[serde(tag = "action", content = "payload", rename_all = "snake_case")]
enum BridgeAction<'a> {
    Execute(&'a RunRArguments),
    Snapshot(&'a SnapshotArguments),
    InspectObject(&'a InspectArguments),
}

#[derive(Serialize)]
struct BridgeRequest<'a> {
    protocol_version: u16,
    request_id: &'a str,
    #[serde(flatten)]
    action: BridgeAction<'a>,
}

#[async_trait]
impl WorkspaceRuntime for ArkRuntime {
    fn session_id(&self) -> &str {
        &self.session_id
    }

    async fn query(
        &self,
        query: &WorkspaceQuery,
    ) -> Result<WorkspaceObservation, WorkspaceRuntimeError> {
        let id = format!("query_{}", Uuid::new_v4().simple());
        let action = match query {
            WorkspaceQuery::Snapshot(args) => BridgeAction::Snapshot(args),
            WorkspaceQuery::InspectObject(args) => BridgeAction::InspectObject(args),
        };
        let (response, _, result_path) = self
            .bridge_call(&id, action, watch::channel(false).1)
            .await?;
        // Query transport files are temporary; no Operation or retained query history.
        let _ = std::fs::remove_file(result_path);
        let data = match query {
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
        Ok(WorkspaceObservation {
            session_id: self.session_id.clone(), source: "ark/rho.bridge".into(),
            observed_at_ms: now_ms(), data, completeness: ObservationCompleteness::Partial,
            notices: vec!["Bounded live observation; lazy/active bindings and classed values are not evaluated.".into()],
        })
    }

    async fn execute(
        &self,
        operation: &Operation,
        request: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        self.execute_controlled(operation, request, watch::channel(false).1)
            .await
    }

    async fn execute_controlled(
        &self,
        operation: &Operation,
        request: &RunRArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        let (response, captured, result_path) = self
            .bridge_call(
                operation.operation_id.as_str(),
                BridgeAction::Execute(request),
                cancellation,
            )
            .await?;
        let observed_at_ms = now_ms();
        Ok(WorkspaceRuntimeReport {
            session_id: self.session_id.clone(),
            value: response.value,
            stdout: captured.stdout,
            stderr: captured.stderr,
            conditions: response.conditions,
            output_references: captured.displays,
            effect_observations: vec![EffectObservation {
                kind: "r_execution".into(),
                source: "ark".into(),
                detail: json!({"child_pid":self.child_pid(), "outcome":response.outcome,
                    "output_truncated":captured.truncated || response.conditions_truncated,
                    "containment":"native_user_process", "result_path":result_path}),
                observed_at_ms,
                completeness: ObservationCompleteness::Partial,
            }],
            outcome: response.outcome,
            error: response.error,
        })
    }
}

impl ArkRuntime {
    async fn bridge_call(
        &self,
        id: &str,
        action: BridgeAction<'_>,
        cancellation: watch::Receiver<bool>,
    ) -> Result<(BridgeResponse, CapturedOutput, PathBuf), WorkspaceRuntimeError> {
        let result_path = self
            .data_root
            .join(format!("{:x}.json", Sha256::digest(id.as_bytes())));
        let bridge_request = BridgeRequest {
            protocol_version: 1,
            request_id: id,
            action,
        };
        let request_json = serde_json::to_string(&bridge_request).map_err(before)?;
        let code = format!(
            "local({{ request <- jsonlite::fromJSON({}, simplifyVector = FALSE); response <- getOption('rho.next.bridge')$rho_dispatch(request); jsonlite::write_json(response, {}, auto_unbox = TRUE, null = 'null', digits = NA); invisible(NULL) }})",
            quote(&request_json).map_err(before)?,
            quote(&result_path.to_string_lossy()).map_err(before)?
        );
        let captured = self.evaluate(code, cancellation).await?;
        if let Some(error) = &captured.protocol_error {
            return Err(WorkspaceRuntimeError::after_possible_effect(
                format!("Ark execution protocol returned an error: {error}"),
                Some(
                    json!({"session_id": self.session_id, "result_path":result_path,
                    "action":"observe_owner_before_any_retry"}),
                ),
            ));
        }
        let read_report = || -> Result<BridgeResponse, String> {
            let mut bytes = Vec::new();
            std::fs::File::open(&result_path)
                .map_err(|e| e.to_string())?
                .take((OUTPUT_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > OUTPUT_LIMIT {
                return Err("R bridge response exceeded byte limit".into());
            }
            let response: BridgeResponse =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if response.protocol_version != 1 || response.request_id != id {
                return Err("R bridge response correlation mismatch".into());
            }
            Ok(response)
        };
        let response = read_report().map_err(|error| WorkspaceRuntimeError::after_possible_effect(error,
            Some(json!({"session_id":self.session_id, "result_path":result_path, "kernel_error":captured.protocol_error}))))?;
        Ok((response, captured, result_path))
    }
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
fn before(error: impl std::fmt::Display) -> WorkspaceRuntimeError {
    WorkspaceRuntimeError::before_effect(error.to_string())
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
