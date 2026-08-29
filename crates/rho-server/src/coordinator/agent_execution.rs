pub trait WorkspaceSnapshotAdapter: Send + Sync {
    fn snapshot<'a>(
        &'a self,
        payload: Value,
        execution_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;
}

pub trait AgentPluginContributionAdapter: Send + Sync {
    fn invoke<'a>(
        &'a self,
        contribution_id: &'a str,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;
}

#[derive(Clone, Default)]
pub struct AgentRuntimeAdapters {
    pub workspace_snapshot: Option<Arc<dyn WorkspaceSnapshotAdapter>>,
    pub plugin_contribution: Option<Arc<dyn AgentPluginContributionAdapter>>,
}

fn configure_agent_process_environment(
    command: &mut tokio::process::Command,
    process_path: Option<&std::ffi::OsStr>,
    _user_environ: Option<&str>,
    credential_environment_names: &[String],
    inherited_environment_names: impl IntoIterator<Item = OsString>,
    credential_override: Option<(&str, &str)>,
) {
    for name in inherited_environment_names {
        if name
            .to_str()
            .is_some_and(rho_kernel::is_sensitive_environment_name)
        {
            command.env_remove(name);
        }
    }
    for name in credential_environment_names {
        command.env_remove(name);
    }
    if let Some(process_path) = process_path {
        command.env("PATH", process_path);
    }
    if let Some((name, value)) = credential_override {
        command.env(name, value);
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run_agent_turn(
    session: &ArkSession,
    context: Arc<WorkspaceBrokerLane>,
    agent_store: AgentRepository,
    project_root: String,
    rscript: PathBuf,
    process_path: Option<OsString>,
    agent_package: PathBuf,
    model: String,
    runtime_profile: Option<AgentRuntimeModelProfile>,
    user_environ: Option<String>,
    credential_environment_names: Vec<String>,
    credential_override: Option<(String, String)>,
    prompt: String,
    mode: String,
    turn_id: String,
    conversation_id: String,
    workspace_lane: Arc<AgentWorkspaceLane>,
    approvals: Arc<PendingApprovalRegistry>,
    environment_approvals: Arc<PendingApprovalRegistry>,
    auto_approve: bool,
    editor_context: Option<Value>,
    explicit_context: Option<AgentExplicitContextItem>,
    expected_plan_digest: Option<String>,
    adapters: AgentRuntimeAdapters,
    plugin_context: Vec<AgentPluginContextItem>,
) -> Result<Value> {
    ensure!(
        matches!(mode.as_str(), "ask" | "plan" | "act"),
        "unsupported Agent mode `{mode}`"
    );
    let result = async {
        let history = agent_store
            .recent_conversation(
                project_root.clone(),
                conversation_id.clone(),
                turn_id.clone(),
                100,
            )
            .await?;
        let project_skills = Some(discover_project_skills(&project_root));
        if !plugin_context.is_empty() {
            let origins = plugin_context
                .iter()
                .map(|item| {
                    json!({
                        "kind": item.kind,
                        "contribution_id": item.contribution_id,
                        "plugin_id": item.plugin_id,
                        "package_digest": item.package_digest,
                        "status": item.status
                    })
                })
                .collect::<Vec<_>>();
            agent_store
                .append_turn_event(AgentTurnEventDraft {
                    turn_id: turn_id.clone(),
                    event_type: "agent.plugin_context".to_string(),
                    title: "Workspace plugin context".to_string(),
                    body: Some(
                        "Untrusted Source and Skill context was attached with exact package origin."
                            .to_string(),
                    ),
                    status: "completed".to_string(),
                    tool: None,
                    request_id: None,
                    code: None,
                    details_json: serde_json::to_string(&json!({"origins": origins}))?,
                })
                .await?;
        }
        let runtime_profile = runtime_profile
            .with_context(|| format!("missing runtime profile for Agent model `{model}`"))?;
        let context_plan = plan_agent_context(
            &prompt,
            &history,
            editor_context.as_ref(),
            project_skills.as_ref(),
            &plugin_context,
            explicit_context.as_ref(),
            &runtime_profile,
            &turn_id,
            &conversation_id,
        )?;
        if explicit_context.is_some() {
            let expected = expected_plan_digest
                .as_deref()
                .context("Explicit Agent context requires a reviewed context-plan digest")?;
            ensure!(
                expected == context_plan.digest,
                "Agent context changed after review. Review the current context plan and send again."
            );
        } else if let Some(expected) = expected_plan_digest.as_deref() {
            ensure!(
                expected == context_plan.digest,
                "Agent context changed after review. Review the current context plan and send again."
            );
        }
        agent_store
            .record_context_items(
                project_root.clone(),
                turn_id.clone(),
                context_plan.receipts.clone(),
            )
            .await?;
        let model_prompt = context_plan.model_prompt;
        let mut authenticator = AgentAuthenticator::bind().await?;
        let address = authenticator.local_addr()?;
        let token = authenticator.bootstrap_token()?.to_string();
        let agent_script = write_desktop_agent_turn_script()?;
        let args = desktop_agent_turn_args(
            agent_script.path(),
            address.port(),
            &agent_package,
            &mode,
        );
        let stdin_payload = desktop_agent_turn_stdin(&token, &runtime_profile, &model_prompt)?;
        let mut command = tokio::process::Command::new(rscript);
        hide_console_window(&mut command);
        configure_agent_process_environment(
            &mut command,
            process_path.as_deref(),
            user_environ.as_deref(),
            &credential_environment_names,
            std::env::vars_os().map(|(name, _)| name),
            credential_override
                .as_ref()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        );
        let mut child = command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("spawning desktop Agent R turn")?;
        let mut stdin = child.stdin.take().context("opening Agent R stdin")?;
        stdin.write_all(stdin_payload.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);

        let authentication = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            authenticator.authenticate_next(),
        )
        .await;
        let mut agent = match authentication {
            Ok(Ok(agent)) => agent,
            Ok(Err(error)) => {
                let _ = child.kill().await;
                let output = child.wait_with_output().await?;
                bail!(
                    "desktop Agent R authentication failed: {error}; process status {}; stdout: {}; stderr: {}",
                    output.status,
                    bounded_agent_context_text(
                        &redact_sensitive_text(&String::from_utf8_lossy(&output.stdout)),
                        4_000
                    ),
                    bounded_agent_context_text(
                        &redact_sensitive_text(&String::from_utf8_lossy(&output.stderr)),
                        4_000
                    )
                );
            }
            Err(_) => {
                let _ = child.kill().await;
                let output = child.wait_with_output().await?;
                bail!(
                    "timed out waiting for desktop Agent R authentication; process status {}; stdout: {}; stderr: {}",
                    output.status,
                    bounded_agent_context_text(
                        &redact_sensitive_text(&String::from_utf8_lossy(&output.stdout)),
                        4_000
                    ),
                    bounded_agent_context_text(
                        &redact_sensitive_text(&String::from_utf8_lossy(&output.stderr)),
                        4_000
                    )
                );
            }
        };
        send_shared_identity(&mut agent, context.clone(), &agent_store).await?;
        let completion_result = serve_desktop_agent(
            &mut agent,
            session,
            context.clone(),
            agent_store.clone(),
            &project_root,
            &turn_id,
            &mode,
            workspace_lane,
            approvals.clone(),
            environment_approvals.clone(),
            auto_approve,
            adapters,
        )
        .await;
        let output = tokio::time::timeout(
            DESKTOP_AGENT_TURN_TIMEOUT,
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
        let after = context.identity();
        agent_store
            .finish_turn(AgentTurnFinish {
            turn_id: turn_id.clone(),
            status: if completion.failed {
                "failed"
            } else {
                "completed"
            }
            .to_string(),
            terminal_reason: completion.failed.then(|| "agent_failure".to_string()),
            workspace_id_after: Some(after.workspace_id.clone()),
            state_revision_after: Some(after.state_revision as i64),
            project_revision_after: Some(after.project_revision as i64),
            final_message: completion.final_message.clone(),
            error_message: completion.error_message.clone(),
            })
            .await?;
        Ok(json!({
            "turn_id": turn_id,
            "model": model,
            "mode": mode,
            "workspace": after.as_ref(),
            "events": completion.events,
            "status": if completion.failed { "failed" } else { "completed" },
            "stdout": redact_sensitive_text(&String::from_utf8_lossy(&output.stdout)),
            "stderr": redact_sensitive_text(&String::from_utf8_lossy(&output.stderr))
        }))
    }
    .await;

    if let Err(error) = &result {
        let after = context.identity();
        agent_store
            .finish_turn(AgentTurnFinish {
                turn_id,
                status: "failed".to_string(),
                terminal_reason: Some("agent_failure".to_string()),
                workspace_id_after: Some(after.workspace_id.clone()),
                state_revision_after: Some(after.state_revision as i64),
                project_revision_after: Some(after.project_revision as i64),
                final_message: None,
                error_message: Some(redact_sensitive_text(&error.to_string())),
            })
            .await?;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn serve_desktop_agent(
    agent: &mut AuthenticatedAgent,
    session: &ArkSession,
    context: Arc<WorkspaceBrokerLane>,
    agent_store: AgentRepository,
    project_root: &str,
    turn_id: &str,
    mode: &str,
    workspace_lane: Arc<AgentWorkspaceLane>,
    approvals: Arc<PendingApprovalRegistry>,
    environment_approvals: Arc<PendingApprovalRegistry>,
    auto_approve: bool,
    adapters: AgentRuntimeAdapters,
) -> Result<DesktopAgentCompletion> {
    let mut events = Vec::new();
    let mut final_message = None;
    let mut approved_mutations = HashMap::new();
    loop {
        let incoming = tokio::time::timeout(
            DESKTOP_AGENT_REQUEST_TIMEOUT,
            read_async_frame(&mut agent.stream),
        )
        .await
        .context("timed out waiting for desktop Agent R request")??;
        agent_store.append_protocol_event(incoming.clone()).await?;

        ensure!(
            agent_store
                .get_turn_detail(project_root.to_string(), turn_id.to_string())
                .await?
                .is_some(),
            "Agent turn does not belong to the active project"
        );

        match incoming.kind {
            MessageKind::Request => {
                let request_type = incoming.payload["type"].as_str().unwrap_or_default();
                let result = if request_type == "tool.approval_required" {
                    handle_tool_approval_required(
                        &incoming,
                        turn_id,
                        mode,
                        session,
                        context.clone(),
                        &agent_store,
                        approvals.clone(),
                        environment_approvals.clone(),
                        &mut approved_mutations,
                        auto_approve,
                    )
                    .await
                } else {
                    let authorization = authorize_agent_workspace_request(
                        mode,
                        request_type,
                        &incoming.payload,
                        &mut approved_mutations,
                    );
                    match authorization {
                        Ok(()) => {
                            dispatch_agent_workspace_request(
                                request_type,
                                &incoming.payload,
                                session,
                                context.clone(),
                                agent_store.clone(),
                                project_root,
                                turn_id,
                                workspace_lane.clone(),
                                adapters.clone(),
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    }
                };
                let workspace = context.identity();
                let response = desktop_agent_response(
                    request_type,
                    &incoming.id,
                    result.map_err(|error| error.to_string()),
                    json!(workspace.as_ref()),
                );
                let ok = response.payload["ok"].as_bool().unwrap_or(false);
                agent_store.append_protocol_event(response.clone()).await?;
                write_async_frame(&mut agent.stream, &response).await?;
                if !ok {
                    send_shared_identity(agent, context.clone(), &agent_store).await?;
                }
            }
            MessageKind::Event => {
                let completed = incoming.payload["type"] == "desktop.agent_completed";
                if let Some(text) = event_message_text(&incoming.payload) {
                    final_message = Some(text);
                }
                record_agent_turn_event(&agent_store, turn_id, &incoming.payload).await?;
                let agent_failed = incoming.payload["type"] == "desktop.agent_failed";
                let error_message =
                    agent_failed.then(|| bounded_provider_failure(&incoming.payload));
                events.push(incoming.payload);
                if completed || agent_failed {
                    return Ok(DesktopAgentCompletion {
                        events,
                        final_message,
                        error_message,
                        failed: agent_failed,
                    });
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

#[allow(clippy::too_many_arguments)]
async fn dispatch_agent_workspace_request(
    request_type: &str,
    payload: &Value,
    session: &ArkSession,
    context: Arc<WorkspaceBrokerLane>,
    agent_store: AgentRepository,
    project_root: &str,
    turn_id: &str,
    workspace_lane: Arc<AgentWorkspaceLane>,
    adapters: AgentRuntimeAdapters,
) -> Result<Value> {
    if request_type == "plugin.contribution.invoke" {
        let adapter = adapters
            .plugin_contribution
            .context("No workspace-plugin contribution adapter is active for this Agent turn")?;
        let arguments = payload
            .get("arguments")
            .and_then(Value::as_object)
            .context("plugin contribution request arguments must be an object")?;
        let contribution_id = arguments
            .get("contribution_id")
            .and_then(Value::as_str)
            .context("plugin contribution request omitted contribution_id")?;
        let input = arguments.get("input").cloned().unwrap_or_else(|| json!({}));
        return adapter.invoke(contribution_id, input).await;
    }
    if matches!(
        request_type,
        "conversation.read_turn" | "workspace.read_runtime_output"
    ) {
        return dispatch_agent_context_read_request(
            request_type,
            payload,
            &agent_store,
            project_root,
            turn_id,
        )
        .await;
    }
    let _lane_guard = match workspace_lane.gate.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            record_agent_workspace_wait(&agent_store, turn_id, request_type).await?;
            workspace_lane.gate.lock().await
        }
    };
    let execution_id = format!("agent_workspace_{}", Uuid::new_v4().simple());
    let _execution_guard = workspace_lane.begin_execution(turn_id, &execution_id)?;
    if let Some(result) = dispatch_workspace_snapshot_adapter(
        request_type,
        payload,
        &execution_id,
        adapters.workspace_snapshot.as_ref(),
    )
    .await
    {
        return result;
    }
    let executor = agent_store.store_executor();
    let mut context = context.lock().await;
    let broker = &mut context.broker;
    dispatch_workspace_request_with_execution_id(
        request_type,
        payload,
        ExecutionOrigin::Agent,
        session,
        broker,
        &executor,
        Some(&execution_id),
    )
    .await
}

fn redacted_bounded_agent_context_text(value: &str, max_chars: usize) -> String {
    bounded_agent_context_text(&redact_sensitive_text(value), max_chars)
}

fn runtime_output_receipt_range(source_id: &str, execution_id: &str) -> Option<(i64, i64)> {
    let range = source_id.strip_prefix(execution_id)?.strip_prefix(':')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<i64>().ok()?;
    let end = end.parse::<i64>().ok()?;
    (start > 0 && end >= start).then_some((start, end))
}

async fn dispatch_agent_context_read_request(
    request_type: &str,
    payload: &Value,
    agent_store: &AgentRepository,
    project_root: &str,
    turn_id: &str,
) -> Result<Value> {
    let arguments = payload
        .get("arguments")
        .and_then(Value::as_object)
        .context("Agent context-read arguments must be an object")?;
    let current = agent_store
        .get_turn_detail(project_root.to_string(), turn_id.to_string())
        .await?
        .context("Agent context read lost its owning turn")?;
    match request_type {
        "conversation.read_turn" => {
            let requested_turn_id = arguments
                .get("turn_id")
                .and_then(Value::as_str)
                .context("conversation.read_turn requires string argument `turn_id`")?;
            ensure!(
                requested_turn_id != turn_id,
                "conversation.read_turn cannot read the active turn"
            );
            let turn = agent_store
                .get_conversation_turn(
                    project_root.to_string(),
                    current.turn.conversation_id.clone(),
                    requested_turn_id.to_string(),
                )
                .await?
                .context("The requested turn is not a terminal turn in this Conversation")?;
            Ok(json!({
                "turn_id": turn.turn_id,
                "conversation_id": current.turn.conversation_id,
                "mode": turn.mode,
                "status": turn.status,
                "started_at": turn.started_at,
                "user_request": redacted_bounded_agent_context_text(&turn.prompt, 16 * 1024),
                "assistant_result": turn.final_message.as_deref().map(|value| redacted_bounded_agent_context_text(value, 16 * 1024)),
                "failure": turn.error_message.as_deref().map(|value| redacted_bounded_agent_context_text(value, 4 * 1024)),
                "bounded": true
            }))
        }
        "workspace.read_runtime_output" => {
            let execution_id = arguments
                .get("execution_id")
                .and_then(Value::as_str)
                .context("workspace.read_runtime_output requires string argument `execution_id`")?;
            let receipt = agent_store
                .list_context_items(project_root.to_string(), turn_id.to_string())
                .await?
                .into_iter()
                .find(|item| {
                    item.source_kind == "runtime_output"
                        && !matches!(
                            item.disposition.as_str(),
                            "unavailable" | "rejected" | "omitted"
                        )
                        && item
                            .source_id
                            .as_deref()
                            .and_then(|source_id| {
                                runtime_output_receipt_range(source_id, execution_id)
                            })
                            .is_some()
                })
                .context(
                    "This Agent turn has no admitted Runtime output reference for that execution",
                )?;
            let (range_start, range_end) = runtime_output_receipt_range(
                receipt.source_id.as_deref().unwrap_or_default(),
                execution_id,
            )
            .context("The admitted Runtime output reference is malformed")?;
            let after_sequence = arguments
                .get("after_sequence")
                .and_then(Value::as_i64)
                .unwrap_or(range_start - 1);
            ensure!(
                after_sequence >= range_start - 1 && after_sequence < range_end,
                "workspace.read_runtime_output cursor is outside the admitted range"
            );
            let page_size = arguments
                .get("page_size")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 50) as usize;
            let page = agent_store
                .runtime_output_page(
                    project_root.to_string(),
                    execution_id.to_string(),
                    after_sequence,
                    page_size,
                    64 * 1024,
                )
                .await?;
            let chunks = page
                .chunks
                .into_iter()
                .filter(|chunk| chunk.sequence <= range_end)
                .map(|chunk| {
                    let payload = match chunk.storage_kind.as_str() {
                        "inline_text" => chunk
                            .text_payload
                            .as_deref()
                            .map(|value| redacted_bounded_agent_context_text(value, 16 * 1024)),
                        "inline_json" | "tombstone" => chunk
                            .json_payload
                            .as_deref()
                            .map(|value| redacted_bounded_agent_context_text(value, 16 * 1024)),
                        _ => None,
                    };
                    json!({
                        "sequence": chunk.sequence,
                        "source_kind": chunk.source_kind,
                        "presentation_kind": chunk.presentation_kind,
                        "media_type": chunk.media_type,
                        "storage_kind": chunk.storage_kind,
                        "payload": payload,
                        "reference_kind": chunk.reference_kind,
                        "reference_id": chunk.reference_id,
                        "payload_bytes": chunk.payload_bytes,
                        "payload_sha256": chunk.payload_sha256,
                    })
                })
                .collect::<Vec<_>>();
            let next_sequence = chunks
                .last()
                .and_then(|chunk| chunk.get("sequence"))
                .and_then(Value::as_i64)
                .unwrap_or(after_sequence);
            Ok(json!({
                "execution_id": execution_id,
                "range_start": range_start,
                "range_end": range_end,
                "range_sha256": receipt.source_sha256,
                "after_sequence": after_sequence,
                "next_sequence": next_sequence,
                "has_more": next_sequence < range_end,
                "status": page.status,
                "output_state": page.output_state,
                "chunks": chunks
            }))
        }
        _ => bail!("unsupported Agent context read `{request_type}`"),
    }
}

async fn dispatch_workspace_snapshot_adapter(
    request_type: &str,
    payload: &Value,
    execution_id: &str,
    adapter: Option<&Arc<dyn WorkspaceSnapshotAdapter>>,
) -> Option<Result<Value>> {
    if request_type != "workspace.snapshot" {
        return None;
    }
    let adapter = adapter?;
    Some(
        adapter
            .snapshot(payload.clone(), execution_id.to_string())
            .await,
    )
}

async fn record_agent_workspace_wait(
    agent_store: &AgentRepository,
    turn_id: &str,
    request_type: &str,
) -> Result<()> {
    agent_store
        .append_turn_event(AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: "resource.waiting".to_string(),
            title: "Waiting for Workspace R".to_string(),
            body: Some(
                "Another Agent turn is using Workspace R. This read will continue in order."
                    .to_string(),
            ),
            status: "running".to_string(),
            tool: Some(request_type.to_string()),
            request_id: None,
            code: None,
            details_json: serde_json::to_string(&json!({
                "lane": "workspace",
                "request_type": request_type
            }))?,
        })
        .await
        .map(|_| ())?;
    Ok(())
}

const DESKTOP_AGENT_RESULT_MAX_BYTES: usize = MAX_FRAME_BYTES / 2;

fn desktop_agent_response(
    request_type: &str,
    request_id: &str,
    result: Result<Value, String>,
    workspace: Value,
) -> Envelope {
    match result {
        Ok(value) => Envelope::new(
            MessageKind::Response,
            json!({
                "type": format!("{request_type}.result"),
                "request_id": request_id,
                "ok": true,
                "result": desktop_agent_result_projection(request_type, value),
                "workspace": workspace
            }),
        ),
        Err(error) => Envelope::new(
            MessageKind::Response,
            json!({
                "type": format!("{request_type}.result"),
                "request_id": request_id,
                "ok": false,
                "error": error,
                "workspace": workspace
            }),
        ),
    }
}

fn desktop_agent_result_projection(request_type: &str, mut value: Value) -> Value {
    if let Some(result) = value.as_object_mut()
        && let Some(events) = result.remove("events")
    {
        let event_count = events.as_array().map_or(0, Vec::len);
        result.insert("event_count".to_string(), json!(event_count));
        result.insert("events_omitted".to_string(), Value::Bool(true));
    }

    let encoded_bytes = serde_json::to_vec(&value)
        .map(|encoded| encoded.len())
        .unwrap_or(usize::MAX);
    if encoded_bytes <= DESKTOP_AGENT_RESULT_MAX_BYTES {
        return value;
    }

    let execution = value.get("execution");
    let execution_error = execution
        .and_then(|item| item.get("error"))
        .and_then(|item| item.get("message"))
        .and_then(Value::as_str)
        .map(|message| bounded_agent_context_text(message, 2_000));
    json!({
        "execution_id": value.get("execution_id").cloned().unwrap_or(Value::Null),
        "artifact_id": value.get("artifact_id").cloned().unwrap_or(Value::Null),
        "artifact_media_type": value.get("artifact_media_type").cloned().unwrap_or(Value::Null),
        "workspace": value.get("workspace").cloned().unwrap_or(Value::Null),
        "execution": {
            "ok": execution.and_then(|item| item.get("ok")).cloned().unwrap_or(Value::Null),
            "error": execution_error.map(|message| json!({"message": message}))
        },
        "event_count": value.get("event_count").cloned().unwrap_or(json!(0)),
        "events_omitted": value.get("events_omitted").cloned().unwrap_or(Value::Bool(false)),
        "response_truncated": true,
        "response_truncation_reason": "agent_frame_budget",
        "request_type": request_type,
        "original_result_bytes": encoded_bytes
    })
}
