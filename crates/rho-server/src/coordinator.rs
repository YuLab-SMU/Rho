use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, bail, ensure};
use rho_agent_transport::{
    AgentAuthenticator, AuthenticatedAgent, read_async_frame, write_async_frame,
};
use rho_core::{BrokerState, ExecutionOrigin, ExecutionRequest};
use rho_kernel::{ArkLaunchConfig, ArkSession};
use rho_protocol::{Envelope, ExpectedWorkspace, MAX_FRAME_BYTES, MessageKind, OperationClass};
use rho_store::{RunDraft, RunFinish, Store};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

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
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating store directory {}", parent.display()))?;
    }

    let mut store = Store::open(&store_path)?;
    let recovered_runs = store.recover_incomplete_runs()?;
    let mut broker = BrokerState::new("ws_phase0_coordinator");
    store.save_identity(broker.identity())?;

    let mut session = ArkSession::launch(&ArkLaunchConfig::new(kernelspec)).await?;
    let run_result = run_probe(
        &mut session,
        &mut broker,
        &mut store,
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

#[allow(clippy::too_many_arguments)]
async fn run_probe(
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
    rscript: PathBuf,
    agent_package: PathBuf,
    bridge_package: PathBuf,
    recovered_runs: usize,
    store_path: &Path,
    model: Option<String>,
    prompt: String,
) -> Result<()> {
    bootstrap_bridge(session, broker, store, &bridge_package).await?;

    let mut authenticator = AgentAuthenticator::bind().await?;
    let address = authenticator.local_addr()?;
    let token = authenticator.bootstrap_token()?.to_string();
    let script = r#"
args <- commandArgs(TRUE)
source(file.path(args[[2]], "R", "aaa-state.R"))
source(file.path(args[[2]], "R", "transport.R"))
token <- readLines(file("stdin"), n = 1L, warn = FALSE)
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
"#;

    let real_model = model.is_some();
    let model_arg = model.clone().unwrap_or_else(|| "mock".to_string());

    let mut child = tokio::process::Command::new(rscript)
        .arg("-e")
        .arg(script)
        .arg(address.port().to_string())
        .arg(agent_package)
        .arg(&model_arg)
        .arg(prompt)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawning Agent R coordinator probe")?;
    let mut stdin = child.stdin.take().context("opening Agent R stdin")?;
    stdin.write_all(format!("{token}\n").as_bytes()).await?;
    stdin.shutdown().await?;

    let mut agent = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        authenticator.authenticate_next(),
    )
    .await
    .context("timed out waiting for Agent R authentication")??;

    send_identity(&mut agent, broker, store).await?;
    if !real_model {
        run_user_probe(session, broker, store).await?;
    }
    let completion_result = serve_agent(&mut agent, session, broker, store).await;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await
    .context("timed out waiting for Agent R coordinator probe")??;
    let completion = completion_result.with_context(|| {
        format!(
            "Agent R loop ended before completion; process status {}; stderr: {}",
            output.status,
            redact_sensitive_text(&String::from_utf8_lossy(&output.stderr))
        )
    })?;
    ensure!(
        output.status.success(),
        "Agent R coordinator probe exited with {}: {}",
        output.status,
        redact_sensitive_text(&String::from_utf8_lossy(&output.stderr))
    );

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "type": "coordinator_probe",
            "model": model,
            "workspace": broker.identity(),
            "completion": completion,
            "persisted_event_count": store.event_count()?,
            "recovered_runs": recovered_runs,
            "store": store_path,
            "python_required": false,
            "stdout": redact_sensitive_text(&String::from_utf8_lossy(&output.stdout)),
            "stderr": redact_sensitive_text(&String::from_utf8_lossy(&output.stderr))
        }))?
    );
    Ok(())
}

pub async fn bootstrap_bridge(
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
    bridge_package: &Path,
) -> Result<()> {
    let bridge_path = r_string(&normalized_path(bridge_package))?;
    let code = format!(
        r#"local({{
  bridge_env <- new.env(parent = asNamespace("utils"))
  for (name in c("state.R", "execute.R", "workspace.R")) {{
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
    store.create_run(&RunDraft {
        run_id: request.execution_id.clone(),
        parent_run_id: None,
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
    })?;
    store.update_run_status(&request.execution_id, "running", None)?;
    let result = session
        .execute(code, |event| {
            append_event(
                store,
                MessageKind::Event,
                json!({
                    "type": "kernel.event",
                    "execution_id": request.execution_id,
                    "event": event
                }),
            )?;
            Ok(())
        })
        .await;
    match result {
        Ok(()) => {
            broker.complete(&request);
            store.save_identity(broker.identity())?;
            let after = broker.identity().clone();
            store.finish_run(&RunFinish {
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
            })?;
            Ok(())
        }
        Err(error) => {
            store.finish_run(&RunFinish {
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
            })?;
            Err(error).context("bootstrapping rho.bridge in Ark")
        }
    }
}

async fn send_identity(
    agent: &mut AuthenticatedAgent,
    broker: &BrokerState,
    store: &mut Store,
) -> Result<()> {
    let event = Envelope::new(
        MessageKind::Event,
        json!({"type": "workspace.identity", "identity": broker.identity()}),
    );
    store.append_event(&event)?;
    write_async_frame(&mut agent.stream, &event).await?;
    Ok(())
}

async fn run_user_probe(
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
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
    store.append_event(&request)?;
    let result = dispatch_workspace_request(
        "workspace.execute",
        &request.payload,
        ExecutionOrigin::User,
        session,
        broker,
        store,
    )
    .await?;
    append_event(
        store,
        MessageKind::Response,
        json!({
            "type": "workspace.execute.result",
            "request_id": request.id,
            "ok": true,
            "result": result
        }),
    )?;
    Ok(())
}

async fn serve_agent(
    agent: &mut AuthenticatedAgent,
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
) -> Result<Value> {
    loop {
        let incoming = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            read_async_frame(&mut agent.stream),
        )
        .await
        .context("timed out waiting for Agent R request")??;
        store.append_event(&incoming)?;

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
                        store,
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
                        store.append_event(&response)?;
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
                        store.append_event(&response)?;
                        write_async_frame(&mut agent.stream, &response).await?;
                        send_identity(agent, broker, store).await?;
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

pub async fn dispatch_workspace_request(
    request_type: &str,
    payload: &Value,
    origin: ExecutionOrigin,
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
) -> Result<Value> {
    let expected: ExpectedWorkspace = serde_json::from_value(
        payload
            .get("expected_workspace")
            .cloned()
            .context("Agent request omitted expected_workspace")?,
    )
    .context("decoding expected_workspace")?;
    let arguments = payload
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (operation_class, bridge_expression) = bridge_expression(request_type, &arguments)?;
    let mut request =
        ExecutionRequest::new(origin, operation_class, expected, bridge_expression.clone());
    broker.authorize(&request)?;
    let before = broker.identity().clone();
    store.create_run(&RunDraft {
        run_id: request.execution_id.clone(),
        parent_run_id: arguments
            .get("parent_run_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        origin: execution_origin_name(origin).to_string(),
        request_type: request_type.to_string(),
        operation_class: operation_class_name(operation_class).to_string(),
        code: requested_code(request_type, &arguments, &bridge_expression),
        arguments_json: serde_json::to_string(&arguments)?,
        source_path: arguments
            .get("source_path")
            .and_then(Value::as_str)
            .map(str::to_string),
        execution_mode: arguments
            .get("execution_mode")
            .and_then(Value::as_str)
            .map(str::to_string),
        document_version: arguments.get("document_version").and_then(Value::as_i64),
        workspace_id: before.workspace_id.clone(),
        state_revision_before: before.state_revision as i64,
        project_revision_before: before.project_revision as i64,
    })?;
    store.update_run_status(&request.execution_id, "running", None)?;

    let result_file = ResultFile::new(&request.execution_id)?;
    let result_path = r_string(&normalized_path(&result_file.path))?;
    let temporary_path = r_string(&normalized_path(&result_file.temporary_path))?;
    let bridge_call = format!(
        r#"local({{
  result <- {bridge_expression}
  payload <- charToRaw(jsonlite::toJSON(
    result,
    auto_unbox = TRUE,
    null = "null",
    digits = NA
  ))
  connection <- file({temporary_path}, open = "wb")
  on.exit(close(connection), add = TRUE)
  writeBin(payload, connection)
  close(connection)
  on.exit(NULL)
  if (!file.rename({temporary_path}, {result_path})) {{
    stop("Failed to publish the structured rho.bridge result.", call. = FALSE)
  }}
  invisible(NULL)
}})"#
    );
    request.code = bridge_call.clone();
    let mut kernel_events = Vec::new();
    let execution = session
        .execute(bridge_call, |event| {
            kernel_events.push(event.clone());
            append_event(
                store,
                MessageKind::Event,
                json!({
                    "type": "kernel.event",
                    "execution_id": request.execution_id,
                    "event": event
                }),
            )?;
            Ok(())
        })
        .await;
    match execution {
        Ok(()) => {}
        Err(error) => {
            let cancelled = store.cancel_requested(&request.execution_id).unwrap_or(false);
            store.finish_run(&RunFinish {
                run_id: request.execution_id.clone(),
                status: if cancelled { "interrupted" } else { "failed" }.to_string(),
                terminal_reason: Some(
                    if cancelled {
                        "user_interrupt"
                    } else {
                        "execution_error"
                    }
                    .to_string(),
                ),
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
            })?;
            return Err(error).context("executing Workspace R request");
        }
    }
    let result = match result_file.read_json() {
        Ok(value) => value,
        Err(error) => {
            let cancelled = store.cancel_requested(&request.execution_id).unwrap_or(false);
            store.finish_run(&RunFinish {
                run_id: request.execution_id.clone(),
                status: if cancelled { "interrupted" } else { "failed" }.to_string(),
                terminal_reason: Some(
                    if cancelled {
                        "user_interrupt"
                    } else {
                        "result_unavailable"
                    }
                    .to_string(),
                ),
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
            })?;
            return Err(error);
        }
    };
    broker.complete(&request);
    store.save_identity(broker.identity())?;
    let after = broker.identity().clone();
    let failed = !result["ok"].as_bool().unwrap_or(false);
    store.finish_run(&RunFinish {
        run_id: request.execution_id.clone(),
        status: if failed { "failed" } else { "completed" }.to_string(),
        terminal_reason: failed.then_some("r_error".to_string()),
        workspace_id: Some(after.workspace_id),
        state_revision_after: Some(after.state_revision as i64),
        project_revision_after: Some(after.project_revision as i64),
        stdout: json_string(&result, "stdout"),
        value_text: json_string(&result, "value"),
        messages: json_string_list(&result, "messages"),
        warnings: json_string_list(&result, "warnings"),
        error_message: result
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .map(redact_sensitive_text),
        error_call: result
            .get("error")
            .and_then(|value| value.get("call"))
            .and_then(Value::as_str)
            .map(str::to_string),
        traceback: json_string_list(&result, "traceback")
            .into_iter()
            .chain(json_string_list(&result, "calls"))
            .collect(),
    })?;
    Ok(json!({
        "execution_id": request.execution_id,
        "execution": result,
        "events": kernel_events,
        "workspace": broker.identity()
    }))
}

#[allow(clippy::too_many_arguments)]
pub async fn run_agent_turn(
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
    rscript: PathBuf,
    agent_package: PathBuf,
    model: String,
    prompt: String,
    mode: String,
) -> Result<Value> {
    ensure!(
        matches!(mode.as_str(), "ask" | "plan" | "act"),
        "unsupported Agent mode `{mode}`"
    );
    let mut authenticator = AgentAuthenticator::bind().await?;
    let address = authenticator.local_addr()?;
    let token = authenticator.bootstrap_token()?.to_string();
    let script = r#"
args <- commandArgs(TRUE)
source(file.path(args[[2]], "R", "aaa-state.R"))
source(file.path(args[[2]], "R", "transport.R"))
source(file.path(args[[2]], "R", "aisdk_adapter.R"))
token <- readLines(file("stdin"), n = 1L, warn = FALSE)
connection <- rho_agent_connect(port = as.integer(args[[1]]), token = token)
identity_message <- rho_read_frame(connection)
stopifnot(
  identical(identity_message$kind, "event"),
  identical(identity_message$payload$type, "workspace.identity")
)
rho_agent_set_workspace_identity(identity_message$payload$identity)
mode <- args[[5]]
mode_policy <- switch(
  mode,
  ask = paste(
    "Ask mode is read-only. Use workspace snapshot or object inspection when useful.",
    "Never call run_r."
  ),
  plan = paste(
    "Plan mode is read-only. Inspect context when useful and propose concrete steps.",
    "Never call run_r."
  ),
  act = paste(
    "Act mode may call run_r when execution is needed.",
    "Keep code focused and inspect results before concluding."
  )
)
session <- rho_create_aisdk_session(
  model = args[[3]],
  system_prompt = paste(
    "You are Rho, an AI collaborator inside an R scientific workbench.",
    "The Ark-backed Workspace R is authoritative and persistent.",
    "Use broker tools to observe or change it; do not pretend code ran.",
    "Respond in the language used by the user and keep the answer concise.",
    mode_policy
  ),
  connection = connection
)
rho_run_aisdk_turn(session, args[[4]], connection = connection)
rho_agent_emit(
  "desktop.agent_completed",
  list(model = args[[3]], mode = mode),
  connection
)
close(connection)
"#;

    let mut child = tokio::process::Command::new(rscript)
        .arg("-e")
        .arg(script)
        .arg(address.port().to_string())
        .arg(agent_package)
        .arg(&model)
        .arg(prompt)
        .arg(&mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawning desktop Agent R turn")?;
    let mut stdin = child.stdin.take().context("opening Agent R stdin")?;
    stdin.write_all(format!("{token}\n").as_bytes()).await?;
    stdin.shutdown().await?;

    let mut agent = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        authenticator.authenticate_next(),
    )
    .await
    .context("timed out waiting for desktop Agent R authentication")??;
    send_identity(&mut agent, broker, store).await?;
    let completion_result =
        serve_desktop_agent(&mut agent, session, broker, store, mode == "act").await;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        child.wait_with_output(),
    )
    .await
    .context("timed out waiting for desktop Agent R turn")??;
    let completion = completion_result.with_context(|| {
        format!(
            "Agent R loop ended before completion; process status {}; stderr: {}",
            output.status,
            redact_sensitive_text(&String::from_utf8_lossy(&output.stderr))
        )
    })?;
    ensure!(
        output.status.success(),
        "desktop Agent R turn exited with {}: {}",
        output.status,
        redact_sensitive_text(&String::from_utf8_lossy(&output.stderr))
    );
    Ok(json!({
        "model": model,
        "mode": mode,
        "workspace": broker.identity(),
        "events": completion,
        "stdout": redact_sensitive_text(&String::from_utf8_lossy(&output.stdout)),
        "stderr": redact_sensitive_text(&String::from_utf8_lossy(&output.stderr))
    }))
}

async fn serve_desktop_agent(
    agent: &mut AuthenticatedAgent,
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
    approve_execution: bool,
) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    loop {
        let incoming = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            read_async_frame(&mut agent.stream),
        )
        .await
        .context("timed out waiting for desktop Agent R request")??;
        store.append_event(&incoming)?;

        match incoming.kind {
            MessageKind::Request => {
                let request_type = incoming.payload["type"].as_str().unwrap_or_default();
                let result = if request_type == "tool.approval_required" {
                    Ok(json!({
                        "approved": approve_execution,
                        "policy": if approve_execution {
                            "desktop_act_mode"
                        } else {
                            "desktop_read_only_mode"
                        }
                    }))
                } else {
                    dispatch_workspace_request(
                        request_type,
                        &incoming.payload,
                        ExecutionOrigin::Agent,
                        session,
                        broker,
                        store,
                    )
                    .await
                };
                let response = match result {
                    Ok(value) => Envelope::new(
                        MessageKind::Response,
                        json!({
                            "type": format!("{request_type}.result"),
                            "request_id": incoming.id,
                            "ok": true,
                            "result": value
                        }),
                    ),
                    Err(error) => Envelope::new(
                        MessageKind::Response,
                        json!({
                            "type": format!("{request_type}.result"),
                            "request_id": incoming.id,
                            "ok": false,
                            "error": error.to_string()
                        }),
                    ),
                };
                let ok = response.payload["ok"].as_bool().unwrap_or(false);
                store.append_event(&response)?;
                write_async_frame(&mut agent.stream, &response).await?;
                if !ok {
                    send_identity(agent, broker, store).await?;
                }
            }
            MessageKind::Event => {
                let completed = incoming.payload["type"] == "desktop.agent_completed";
                events.push(incoming.payload);
                if completed {
                    return Ok(events);
                }
            }
            MessageKind::Response | MessageKind::Cancel => {
                bail!(
                    "unexpected desktop Agent R message kind: {:?}",
                    incoming.kind
                )
            }
        }
    }
}

fn bridge_expression(request_type: &str, arguments: &Value) -> Result<(OperationClass, String)> {
    let bridge = r#"getOption("rho.bridge.env")"#;
    match request_type {
        "workspace.execute" => {
            let code = arguments["code"]
                .as_str()
                .context("workspace.execute requires string argument `code`")?;
            Ok((
                OperationClass::StateCapable,
                format!(
                    "{bridge}$rho_execute({}, envir = .GlobalEnv)",
                    r_string(code)?
                ),
            ))
        }
        "workspace.snapshot" => Ok((
            OperationClass::Probe,
            format!("{bridge}$rho_workspace_snapshot(envir = .GlobalEnv)"),
        )),
        "workspace.inspect_object" => {
            let name = arguments["name"]
                .as_str()
                .context("workspace.inspect_object requires string argument `name`")?;
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_inspect_object({}, envir = .GlobalEnv)",
                    r_string(name)?
                ),
            ))
        }
        _ => bail!("unsupported Agent R request type: {request_type}"),
    }
}

fn append_event(store: &mut Store, kind: MessageKind, payload: Value) -> Result<i64> {
    Ok(store.append_event(&Envelope::new(kind, payload))?)
}

fn execution_origin_name(origin: ExecutionOrigin) -> &'static str {
    match origin {
        ExecutionOrigin::User => "user",
        ExecutionOrigin::Agent => "agent",
        ExecutionOrigin::System => "system",
    }
}

fn operation_class_name(class: OperationClass) -> &'static str {
    match class {
        OperationClass::Probe => "probe",
        OperationClass::StateCapable => "state_capable",
        OperationClass::ProjectMutation => "project_mutation",
        OperationClass::StateAndProjectMutation => "state_and_project_mutation",
    }
}

fn requested_code(request_type: &str, arguments: &Value, bridge_expression: &str) -> String {
    match request_type {
        "workspace.execute" => arguments
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or(bridge_expression)
            .to_string(),
        "workspace.inspect_object" => arguments
            .get("name")
            .and_then(Value::as_str)
            .map(|name| format!("inspect {name}"))
            .unwrap_or_else(|| bridge_expression.to_string()),
        _ => bridge_expression.to_string(),
    }
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(redact_sensitive_text)
}

fn json_string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(redact_sensitive_text)
        .collect()
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn r_string(value: &str) -> Result<String> {
    serde_json::to_string(value).context("quoting R string")
}

fn redact_sensitive_text(input: &str) -> String {
    let mut output = input.to_string();
    for name in ["key", "api_key", "apikey", "token", "access_token"] {
        for prefix in ["?", "&"] {
            output = redact_after_marker(&output, &format!("{prefix}{name}="), "& \t\r\n\"'");
        }
        for separator in [":\"", ": \""] {
            output = redact_after_marker(&output, &format!("\"{name}\"{separator}"), "\"\r\n");
        }
    }
    redact_after_marker(&output, "Bearer ", " \t\r\n\"'")
}

fn redact_after_marker(input: &str, marker: &str, terminators: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let marker_lower = marker.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&marker_lower) {
        let start = cursor + relative;
        let value_start = start + marker.len();
        output.push_str(&input[cursor..value_start]);
        output.push_str("[REDACTED]");
        let value_end = input[value_start..]
            .find(|character| terminators.contains(character))
            .map_or(input.len(), |relative| value_start + relative);
        cursor = value_end;
    }
    output.push_str(&input[cursor..]);
    output
}

struct ResultFile {
    path: PathBuf,
    temporary_path: PathBuf,
}

impl ResultFile {
    fn new(execution_id: &str) -> Result<Self> {
        let directory = std::env::temp_dir().join("rho").join("bridge-results");
        std::fs::create_dir_all(&directory)
            .with_context(|| format!("creating bridge result directory {}", directory.display()))?;
        Ok(Self {
            path: directory.join(format!("{execution_id}.json")),
            temporary_path: directory.join(format!("{execution_id}.json.tmp")),
        })
    }

    fn read_json(&self) -> Result<Value> {
        let mut file = std::fs::File::open(&self.path).with_context(|| {
            format!(
                "Workspace R did not publish structured result {}",
                self.path.display()
            )
        })?;
        read_bounded_json(&mut file)
            .with_context(|| format!("reading Workspace R result {}", self.path.display()))
    }
}

fn read_bounded_json(mut reader: impl Read) -> Result<Value> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_FRAME_BYTES,
        "Workspace R result exceeds {} bytes",
        MAX_FRAME_BYTES
    );
    serde_json::from_slice(&bytes).context("decoding structured Workspace R result")
}

impl Drop for ResultFile {
    fn drop(&mut self) {
        for path in [&self.path, &self.temporary_path] {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bounded_bridge_json() {
        assert_eq!(
            read_bounded_json(br#"{"ok":true,"value":42}"#.as_slice()).unwrap(),
            json!({"ok": true, "value": 42})
        );
    }

    #[test]
    fn rejects_oversized_bridge_json_before_unbounded_read() {
        let bytes = vec![b' '; MAX_FRAME_BYTES + 1];
        let error = read_bounded_json(bytes.as_slice()).unwrap_err();
        assert!(error.to_string().contains("exceeds"));
    }

    #[test]
    fn redacts_credentials_from_agent_diagnostics() {
        let input = concat!(
            "https://example.test/models/x?alt=sse&KEY=secret-value&mode=1\n",
            "Authorization: Bearer another-secret\n",
            "{\"api_key\":\"json-secret\",\"access_token\": \"spaced-secret\"}"
        );
        let redacted = redact_sensitive_text(input);
        assert!(!redacted.contains("secret-value"));
        assert!(!redacted.contains("another-secret"));
        assert!(!redacted.contains("json-secret"));
        assert!(!redacted.contains("spaced-secret"));
        assert!(redacted.contains("&KEY=[REDACTED]&mode=1"));
    }
}
