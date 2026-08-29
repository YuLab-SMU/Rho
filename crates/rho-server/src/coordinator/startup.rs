pub async fn probe(
    kernelspec: PathBuf,
    rscript: PathBuf,
    agent_package: PathBuf,
    bridge_package: PathBuf,
    store_path: PathBuf,
    model: Option<String>,
    prompt: String,
) -> Result<()> {
    if let Some(parent) = store_path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating store directory {}", parent.display()))?;
    }

    let executor = StoreExecutor::open(&store_path)
        .await
        .context("opening coordinator probe Store worker")?;
    let probe_project_root = std::env::current_dir()
        .context("resolving the probe project root")?
        .canonicalize()
        .context("canonicalizing the probe project root")?;
    let probe_project_root = normalize_project_root(
        probe_project_root.to_string_lossy().as_ref(),
    );
    let mut broker = BrokerState::new("ws_phase0_coordinator");
    let initial_identity = broker.identity().clone();
    let recovered_runs = run_workspace_store_service(&executor, move |store| {
        store.set_project_root(Some(&probe_project_root))?;
        let recovered_runs = store.recover_incomplete_runs()?;
        store.save_identity(&initial_identity)?;
        Ok(recovered_runs)
    })
    .await?;

    let mut session = ArkSession::launch(&ArkLaunchConfig::new(kernelspec)).await?;
    let run_result = run_probe(
        &session,
        &mut broker,
        &executor,
        rscript,
        agent_package,
        bridge_package,
        recovered_runs,
        &store_path,
        model,
        prompt,
    )
    .await;
    let shutdown_result = session.shutdown().await;
    run_result?;
    shutdown_result
}

/// Multi-line Agent R coordinator probe program. Per the active
/// `windows-agent-r-script-launch-repair-spec` invariant, Agent R code is
/// transported in a flushed UTF-8 temporary `.R` file, never as a multi-line
/// `-e` argument (the pattern that failed Windows turns with `0xc0000005`).
fn coordinator_probe_script() -> &'static str {
    r#"
args <- commandArgs(TRUE)
source(file.path(args[[2]], "R", "aaa-state.R"))
source(file.path(args[[2]], "R", "transport.R"))
input <- file("stdin", open = "r", encoding = "UTF-8")
token <- readLines(input, n = 1L, warn = FALSE)
model_prompt <- paste(readLines(input, warn = FALSE), collapse = "\n")
close(input)
connection <- rho_agent_connect(port = as.integer(args[[1]]), token = token)
identity_message <- rho_read_frame(connection)
stopifnot(
  identical(identity_message$kind, "event"),
  identical(identity_message$payload$type, "workspace.identity")
)
identity <- identity_message$payload$identity
if (identical(args[[3]], "mock")) {
  stale_error <- tryCatch(
    {
      rho_agent_request(
        "workspace.execute",
        list(
          arguments = list(code = "rho_probe_value <- 40 + 2"),
          expected_workspace = identity
        ),
        connection = connection
      )
      NULL
    },
    error = conditionMessage
  )
  stopifnot(is.character(stale_error), grepl("workspace state changed", stale_error))
  identity_message <- rho_read_frame(connection)
  stopifnot(
    identical(identity_message$kind, "event"),
    identical(identity_message$payload$type, "workspace.identity")
  )
  identity <- identity_message$payload$identity
  result <- rho_agent_request(
    "workspace.execute",
    list(
      arguments = list(code = "rho_probe_value <- 40 + 2"),
      expected_workspace = identity
    ),
    connection = connection
  )
  stopifnot(isTRUE(result$execution$ok))
  rho_agent_emit(
    "probe.coordinator_completed",
    list(stale_rejected = TRUE, result = result),
    connection
  )
} else {
  source(file.path(args[[2]], "R", "aisdk_adapter.R"))
  rho_agent_set_workspace_identity(identity)
  session <- rho_create_aisdk_session(
    model = args[[3]],
    system_prompt = paste(
      "You are a Rho runtime verification agent.",
      "You must call run_r exactly once with this exact code:",
      "rho_model_probe_value <- 6 * 7",
      "Do not call other tools.",
      "After the tool succeeds, reply exactly RHO_MODEL_PROBE_OK."
    ),
    connection = connection
  )
  rho_run_aisdk_turn(session, args[[4]], connection = connection)
  inspected <- rho_broker_tool_request(
    "workspace.inspect_object",
    list(name = "rho_model_probe_value")
  )
  stopifnot(
    isTRUE(inspected$execution$name == "rho_model_probe_value"),
    isTRUE(inspected$execution$size_bytes > 0)
  )
  rho_agent_emit(
    "probe.coordinator_completed",
    list(real_model = TRUE, model = args[[3]], inspection = inspected),
    connection
  )
}
close(connection)
"#
}

fn write_coordinator_probe_script() -> Result<tempfile::NamedTempFile> {
    use std::io::Write;

    let mut script_file = tempfile::Builder::new()
        .prefix("rho-coordinator-probe-")
        .suffix(".R")
        .tempfile()
        .context("creating Agent R coordinator probe script file")?;
    script_file
        .write_all(coordinator_probe_script().as_bytes())
        .context("writing Agent R coordinator probe script file")?;
    script_file
        .flush()
        .context("flushing Agent R coordinator probe script file")?;
    Ok(script_file)
}

fn coordinator_probe_args(
    script_path: &Path,
    port: u16,
    agent_package: &Path,
    model: &str,
    prompt: &str,
) -> Vec<OsString> {
    vec![
        script_path.as_os_str().to_os_string(),
        OsString::from(port.to_string()),
        agent_package.as_os_str().to_os_string(),
        OsString::from(model.to_string()),
        OsString::from(prompt.to_string()),
    ]
}

const PROBE_CHILD_DIAGNOSTIC_BYTES: usize = 4_000;

#[derive(Debug)]
struct ProbeChildOutput {
    stdout: tokio::task::JoinHandle<std::io::Result<String>>,
    stderr: tokio::task::JoinHandle<std::io::Result<String>>,
}

impl ProbeChildOutput {
    fn capture(child: &mut tokio::process::Child) -> Result<Self> {
        let stdout = child
            .stdout
            .take()
            .context("capturing Agent R coordinator probe stdout")?;
        let stderr = child
            .stderr
            .take()
            .context("capturing Agent R coordinator probe stderr")?;
        Ok(Self {
            stdout: tokio::spawn(capture_probe_child_stream(stdout)),
            stderr: tokio::spawn(capture_probe_child_stream(stderr)),
        })
    }

    async fn finish(self) -> (String, String) {
        (
            finish_probe_child_stream(self.stdout, "stdout").await,
            finish_probe_child_stream(self.stderr, "stderr").await,
        )
    }
}

async fn capture_probe_child_stream<R>(mut stream: R) -> std::io::Result<String>
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(PROBE_CHILD_DIAGNOSTIC_BYTES);
    let mut chunk = [0_u8; 1_024];
    let mut truncated = false;
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let available = PROBE_CHILD_DIAGNOSTIC_BYTES.saturating_sub(retained.len());
        let keep = available.min(count);
        retained.extend_from_slice(&chunk[..keep]);
        truncated |= keep < count;
    }
    let mut output = String::from_utf8_lossy(&retained).into_owned();
    if truncated {
        output.push_str("... [truncated]");
    }
    Ok(redact_sensitive_text(&output))
}

async fn finish_probe_child_stream(
    task: tokio::task::JoinHandle<std::io::Result<String>>,
    stream: &str,
) -> String {
    match task.await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => format!("[failed to read child {stream}: {error}]"),
        Err(error) => format!("[child {stream} capture task failed: {error}]"),
    }
}

enum ProbeStartup<T, E> {
    Authentication(std::result::Result<T, E>),
    Exited(std::io::Result<std::process::ExitStatus>),
}

async fn stop_probe_child(child: &mut tokio::process::Child) -> Result<std::process::ExitStatus> {
    let _ = child.kill().await;
    child
        .wait()
        .await
        .context("waiting for terminated Agent R coordinator probe")
}

async fn await_probe_authentication<T, E, F>(
    authentication: F,
    child: &mut tokio::process::Child,
    output: ProbeChildOutput,
    timeout: std::time::Duration,
) -> Result<(T, ProbeChildOutput)>
where
    F: Future<Output = std::result::Result<T, E>>,
    E: std::fmt::Display,
{
    tokio::pin!(authentication);
    let startup = tokio::time::timeout(timeout, async {
        tokio::select! {
            authentication = &mut authentication => ProbeStartup::Authentication(authentication),
            status = child.wait() => ProbeStartup::Exited(status),
        }
    })
    .await;

    match startup {
        Ok(ProbeStartup::Authentication(Ok(agent))) => Ok((agent, output)),
        Ok(ProbeStartup::Authentication(Err(error))) => {
            let status = stop_probe_child(child).await?;
            let (stdout, stderr) = output.finish().await;
            bail!(
                "Agent R coordinator probe authentication failed: {error}; process status {status}; stdout: {stdout}; stderr: {stderr}"
            )
        }
        Ok(ProbeStartup::Exited(status)) => {
            let status = status.context("waiting for Agent R coordinator probe authentication")?;
            let (stdout, stderr) = output.finish().await;
            bail!(
                "Agent R coordinator probe exited before authentication with {status}; stdout: {stdout}; stderr: {stderr}"
            )
        }
        Err(_) => {
            let status = stop_probe_child(child).await?;
            let (stdout, stderr) = output.finish().await;
            bail!(
                "timed out waiting for Agent R coordinator probe authentication; process status {status}; stdout: {stdout}; stderr: {stderr}"
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_probe(
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
    rscript: PathBuf,
    agent_package: PathBuf,
    bridge_package: PathBuf,
    recovered_runs: usize,
    store_path: &Path,
    model: Option<String>,
    prompt: String,
) -> Result<()> {
    bootstrap_bridge(session, broker, executor, &bridge_package).await?;

    let mut authenticator = AgentAuthenticator::bind().await?;
    let address = authenticator.local_addr()?;
    let token = authenticator.bootstrap_token()?.to_string();
    let script_file = write_coordinator_probe_script()?;

    let real_model = model.is_some();
    let model_arg = model.clone().unwrap_or_else(|| "mock".to_string());

    let args = coordinator_probe_args(
        script_file.path(),
        address.port(),
        &agent_package,
        &model_arg,
        &prompt,
    );
    let mut command = tokio::process::Command::new(rscript);
    hide_console_window(&mut command);
    let mut child = command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawning Agent R coordinator probe")?;
    let mut stdin = child.stdin.take().context("opening Agent R stdin")?;
    stdin.write_all(format!("{token}\n").as_bytes()).await?;
    stdin.shutdown().await?;
    drop(stdin);

    let output = ProbeChildOutput::capture(&mut child)?;
    let (mut agent, output) = await_probe_authentication(
        authenticator.authenticate_next(),
        &mut child,
        output,
        std::time::Duration::from_secs(30),
    )
    .await?;

    send_identity(&mut agent, broker, executor).await?;
    if !real_model {
        run_user_probe(session, broker, executor).await?;
    }
    let completion_result = serve_agent(&mut agent, session, broker, executor).await;
    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait(),
    )
    .await
    {
        Ok(status) => status.context("waiting for Agent R coordinator probe")?,
        Err(_) => {
            let status = stop_probe_child(&mut child).await?;
            let (stdout, stderr) = output.finish().await;
            bail!(
                "timed out waiting for Agent R coordinator probe; process status {status}; stdout: {stdout}; stderr: {stderr}"
            )
        }
    };
    let (stdout, stderr) = output.finish().await;
    let completion = completion_result.with_context(|| {
        format!(
            "Agent R loop ended before completion; process status {}; stderr: {}",
            status, stderr
        )
    })?;
    ensure!(
        status.success(),
        "Agent R coordinator probe exited with {}: {}",
        status,
        stderr
    );

    let persisted_event_count =
        run_workspace_store_service(executor, |store| Ok(store.event_count()?)).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "type": "coordinator_probe",
            "model": model,
            "workspace": broker.identity(),
            "completion": completion,
            "persisted_event_count": persisted_event_count,
            "recovered_runs": recovered_runs,
            "store": store_path,
            "python_required": false,
            "stdout": stdout,
            "stderr": stderr
        }))?
    );
    Ok(())
}

pub async fn bootstrap_bridge(
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
    bridge_package: &Path,
) -> Result<()> {
    let bridge_path = r_string(&normalized_path(bridge_package))?;
    let code = format!(
        r#"local({{
  bridge_env <- new.env(parent = asNamespace("utils"))
  for (name in c("state.R", "execute.R", "workspace.R", "completion.R", "lintr.R", "targets.R", "formatting.R")) {{
    sys.source(file.path({bridge_path}, "R", name), envir = bridge_env)
  }}
  options(rho.bridge.env = bridge_env)
  invisible(TRUE)
}})"#
    );
    let request = ExecutionRequest::new(
        ExecutionOrigin::System,
        OperationClass::StateCapable,
        ExpectedWorkspace::default(),
        code.clone(),
    );
    let before = broker.identity().clone();
    let project_root = run_workspace_store_service(executor, |store| {
        store
            .active_project_root()?
            .context("Cannot persist bootstrap run without an active project identity")
    })
    .await?;
    let run_draft = RunDraft {
        run_id: request.execution_id.clone(),
        parent_run_id: None,
        project_root: project_root.clone(),
        origin: execution_origin_name(request.origin).to_string(),
        request_type: "workspace.bootstrap".to_string(),
        operation_class: operation_class_name(request.operation_class).to_string(),
        code: code.clone(),
        arguments_json: "{}".to_string(),
        source_path: None,
        execution_mode: Some("bootstrap".to_string()),
        document_version: None,
        workspace_id: before.workspace_id.clone(),
        state_revision_before: before.state_revision as i64,
        project_revision_before: before.project_revision as i64,
        environment_snapshot_id: None,
    };
    let run_id = request.execution_id.clone();
    run_workspace_store_service(executor, move |store| {
        store.create_run(&run_draft)?;
        store.update_run_status(&run_id, "running", None)?;
        Ok(())
    })
    .await?;
    let event_executor = executor.clone();
    let event_execution_id = request.execution_id.clone();
    let result = session
        .execute_async(code, move |event| {
            let executor = event_executor.clone();
            let execution_id = event_execution_id.clone();
            async move {
                run_workspace_store_service(&executor, move |store| {
                    append_event(
                        store,
                        MessageKind::Event,
                        json!({
                            "type": "kernel.event",
                            "execution_id": execution_id,
                            "event": event
                        }),
                    )?;
                    Ok(())
                })
                .await
            }
        })
        .await;
    match result {
        Ok(()) => {
            broker.complete(&request);
            let after = broker.identity().clone();
            let identity = broker.identity().clone();
            let finish = RunFinish {
                run_id: request.execution_id,
                status: "completed".to_string(),
                terminal_reason: None,
                workspace_id: Some(after.workspace_id),
                state_revision_after: Some(after.state_revision as i64),
                project_revision_after: Some(after.project_revision as i64),
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: None,
            };
            run_workspace_store_service(executor, move |store| {
                store.save_identity(&identity)?;
                store.finish_run(&finish)?;
                Ok(())
            })
            .await?;
            Ok(())
        }
        Err(error) => {
            let finish = RunFinish {
                run_id: request.execution_id,
                status: "failed".to_string(),
                terminal_reason: Some("bootstrap_error".to_string()),
                workspace_id: None,
                state_revision_after: None,
                project_revision_after: None,
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: Some(redact_sensitive_text(&error.to_string())),
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: None,
            };
            run_workspace_store_service(executor, move |store| {
                store.finish_run(&finish)?;
                Ok(())
            })
            .await?;
            Err(error).context("bootstrapping rho.bridge in Ark")
        }
    }
}

async fn send_identity(
    agent: &mut AuthenticatedAgent,
    broker: &BrokerState,
    executor: &StoreExecutor,
) -> Result<()> {
    let event = Envelope::new(
        MessageKind::Event,
        json!({"type": "workspace.identity", "identity": broker.identity()}),
    );
    executor
        .agent_repository()
        .append_protocol_event(event.clone())
        .await?;
    write_async_frame(&mut agent.stream, &event).await?;
    Ok(())
}

async fn send_shared_identity(
    agent: &mut AuthenticatedAgent,
    context: Arc<WorkspaceBrokerLane>,
    agent_store: &AgentRepository,
) -> Result<()> {
    let identity = context.identity();
    let event = Envelope::new(
        MessageKind::Event,
        json!({"type": "workspace.identity", "identity": identity.as_ref()}),
    );
    agent_store.append_protocol_event(event.clone()).await?;
    write_async_frame(&mut agent.stream, &event).await?;
    Ok(())
}

async fn run_user_probe(
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
) -> Result<()> {
    let request = Envelope::new(
        MessageKind::Request,
        json!({
            "type": "workspace.execute",
            "logical_client": "user",
            "arguments": {"code": "rho_user_probe_value <- 1"},
            "expected_workspace": broker.identity()
        }),
    );
    let agent_store = executor.agent_repository();
    agent_store.append_protocol_event(request.clone()).await?;
    let result = dispatch_workspace_request(
        "workspace.execute",
        &request.payload,
        ExecutionOrigin::User,
        session,
        broker,
        executor,
    )
    .await?;
    agent_store
        .append_protocol_event(Envelope::new(
            MessageKind::Response,
            json!({
            "type": "workspace.execute.result",
            "request_id": request.id,
            "ok": true,
            "result": result
            }),
        ))
        .await?;
    Ok(())
}

async fn serve_agent(
    agent: &mut AuthenticatedAgent,
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
) -> Result<Value> {
    let agent_store = executor.agent_repository();
    loop {
        let incoming = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            read_async_frame(&mut agent.stream),
        )
        .await
        .context("timed out waiting for Agent R request")??;
        agent_store.append_protocol_event(incoming.clone()).await?;

        match incoming.kind {
            MessageKind::Request => {
                let request_type = incoming.payload["type"].as_str().unwrap_or_default();
                let result = if request_type == "tool.approval_required" {
                    Ok(json!({
                        "approved": true,
                        "policy": "phase0_probe_only"
                    }))
                } else {
                    dispatch_workspace_request(
                        request_type,
                        &incoming.payload,
                        ExecutionOrigin::Agent,
                        session,
                        broker,
                        executor,
                    )
                    .await
                };
                match result {
                    Ok(value) => {
                        let response = Envelope::new(
                            MessageKind::Response,
                            json!({
                                "type": format!("{request_type}.result"),
                                "request_id": incoming.id,
                                "ok": true,
                                "result": value
                            }),
                        );
                        agent_store.append_protocol_event(response.clone()).await?;
                        write_async_frame(&mut agent.stream, &response).await?;
                    }
                    Err(error) => {
                        let response = Envelope::new(
                            MessageKind::Response,
                            json!({
                                "type": format!("{request_type}.result"),
                                "request_id": incoming.id,
                                "ok": false,
                                "error": error.to_string()
                            }),
                        );
                        agent_store.append_protocol_event(response.clone()).await?;
                        write_async_frame(&mut agent.stream, &response).await?;
                        send_identity(agent, broker, executor).await?;
                    }
                }
            }
            MessageKind::Event if incoming.payload["type"] == "probe.coordinator_completed" => {
                return Ok(incoming.payload);
            }
            MessageKind::Event => {}
            MessageKind::Response | MessageKind::Cancel => {
                bail!("unexpected Agent R message kind: {:?}", incoming.kind)
            }
        }
    }
}
