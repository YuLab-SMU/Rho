fn authorize_agent_workspace_request(
    mode: &str,
    request_type: &str,
    payload: &Value,
    approved_mutations: &mut HashMap<String, ApprovedMutation>,
) -> Result<()> {
    match request_type {
        "workspace.snapshot"
        | "conversation.read_turn"
        | "workspace.read_runtime_output"
        | "workspace.inspect_object"
        | "workspace.inspect_data_object"
        | "workspace.list_package_functions"
        | "workspace.function_help"
        | "workspace.lint_file"
        | "workspace.format_r_source"
        | "workspace.inspect_targets"
        | "workspace.read_data_view"
        | "plugin.contribution.invoke" => Ok(()),
        "workspace.execute"
        | "environment.initialize"
        | "environment.restore"
        | "environment.snapshot"
        | "environment.package_install"
        | "environment.package_update"
        | "environment.package_remove" => {
            ensure!(mode == "act", "{mode} mode cannot mutate Workspace R");
            let request_id = payload
                .get("approval_request_id")
                .and_then(Value::as_str)
                .context("Agent mutation omitted approval_request_id")?;
            let approved = approved_mutations
                .remove(request_id)
                .context("Agent mutation has no live broker approval")?;
            ensure!(
                approved.request_type == request_type,
                "Approved request type does not match Agent mutation"
            );
            let arguments = payload
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            ensure!(
                approved_arguments_match(&approved.arguments, &arguments),
                "Agent mutation arguments differ from the approved request"
            );
            Ok(())
        }
        _ => bail!("Agent request type `{request_type}` is not allowed by desktop policy"),
    }
}

fn approved_arguments_match(approved: &Value, actual: &Value) -> bool {
    match (
        approved.get("code").and_then(Value::as_str),
        actual.get("code").and_then(Value::as_str),
    ) {
        (Some(approved_code), Some(actual_code)) => approved_code == actual_code,
        _ => approved == actual,
    }
}

fn agent_tool_request_type(tool: &str) -> Option<&'static str> {
    match tool {
        "run_r" => Some("workspace.execute"),
        "initialize_project_environment" => Some("environment.initialize"),
        "restore_project_environment" => Some("environment.restore"),
        "snapshot_project_environment" => Some("environment.snapshot"),
        "install_project_package" => Some("environment.package_install"),
        "update_project_package" => Some("environment.package_update"),
        "remove_project_package" => Some("environment.package_remove"),
        _ => None,
    }
}

fn request_type_uses_environment_contract(request_type: &str) -> bool {
    matches!(
        request_type,
        "environment.initialize"
            | "environment.restore"
            | "environment.snapshot"
            | "environment.package_install"
            | "environment.package_update"
            | "environment.package_remove"
    )
}

fn tool_environment_operation_arguments(
    tool: &str,
    arguments: &Value,
) -> Result<EnvironmentOperationArguments> {
    let repositories = arguments
        .get("repositories")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .context("decoding environment operation repositories")?;
    let bioconductor = arguments
        .get("bioconductor")
        .and_then(Value::as_str)
        .map(str::to_string);
    let package = arguments
        .get("package")
        .and_then(Value::as_str)
        .map(str::to_string);
    let operation = match tool {
        "initialize_project_environment" => "initialize",
        "restore_project_environment" => "restore",
        "snapshot_project_environment" => "snapshot",
        "install_project_package" => "install_package",
        "update_project_package" => "update_package",
        "remove_project_package" => "remove_package",
        _ => bail!("unsupported environment tool `{tool}`"),
    };
    Ok(EnvironmentOperationArguments {
        operation: operation.to_string(),
        project_root: None,
        repositories,
        bioconductor,
        package,
        project_library: None,
    })
}

async fn handle_tool_approval_required(
    incoming: &Envelope,
    turn_id: &str,
    mode: &str,
    session: &ArkSession,
    context: Arc<WorkspaceBrokerLane>,
    agent_store: &AgentRepository,
    approvals: Arc<PendingApprovalRegistry>,
    environment_approvals: Arc<PendingApprovalRegistry>,
    approved_mutations: &mut HashMap<String, ApprovedMutation>,
    auto_approve: bool,
) -> Result<Value> {
    let executor = agent_store.store_executor();
    let tool = incoming.payload["tool"]
        .as_str()
        .unwrap_or("run_r")
        .to_string();
    let arguments = incoming
        .payload
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let policy = incoming.payload["policy"]
        .as_str()
        .unwrap_or("required")
        .to_string();
    let request_id = incoming.id.clone();
    let request_type = agent_tool_request_type(&tool);
    let uses_environment_contract =
        request_type.is_some_and(request_type_uses_environment_contract);
    let mut context_guard = context.lock().await;
    let WorkspaceBrokerState { broker, .. } = &mut *context_guard;
    let identity = broker.identity().clone();
    let code = arguments
        .get("code")
        .and_then(Value::as_str)
        .map(str::to_string);

    if mode != "act" || request_type.is_none() {
        let reason = if mode != "act" {
            format!("{mode} mode is read-only and cannot execute `{tool}`")
        } else {
            format!("Tool `{tool}` is not approved for Workspace mutation")
        };
        agent_store
            .append_turn_event(AgentTurnEventDraft {
                turn_id: turn_id.to_string(),
                event_type: "approval.policy_denied".to_string(),
                title: format!("Policy denied · {tool}"),
                body: Some(reason.clone()),
                status: "error".to_string(),
                tool: Some(tool),
                request_id: Some(request_id.clone()),
                code,
                details_json: serde_json::to_string(&incoming.payload)?,
            })
            .await?;
        return Ok(json!({
            "approved": false,
            "request_id": request_id,
            "decision": "policy_denied",
            "reason": reason,
            "policy": "desktop_read_only_mode"
        }));
    }

    if uses_environment_contract {
        let environment_arguments = tool_environment_operation_arguments(&tool, &arguments)?;
        let request = request_environment_operation(
            environment_arguments,
            Some(turn_id),
            "agent",
            session,
            broker,
            &executor,
        )
        .await?;
        let request_type = request.request_name.clone();
        let approved_arguments: Value = serde_json::from_str(&request.arguments_json)
            .context("decoding approved environment operation arguments")?;
        let receiver = environment_approvals
            .register(request.request_id.clone(), Some(turn_id.to_string()))
            .await;
        let waiting_turn_id = turn_id.to_string();
        let waiting_event = AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: "environment.requested".to_string(),
            title: format!("Environment review required · {}", request.request_name),
            body: Some(
                "Project environment remains unchanged until you approve this reviewed operation."
                    .to_string(),
            ),
            status: "running".to_string(),
            tool: Some(tool.clone()),
            request_id: Some(request.request_id.clone()),
            code: None,
            details_json: serde_json::to_string(&json!({
                "tool": tool,
                "policy": policy,
                "preview_sha256": request.preview_sha256,
                "before_snapshot_id": request.before_snapshot_id,
                "project_root": request.project_root
            }))?,
        };
        let waiting_event_id = run_workspace_store_service(&executor, move |store| {
            store.update_agent_turn_status(&waiting_turn_id, "waiting")?;
            let event_id = store.append_agent_turn_event(&waiting_event)?;
            Ok(event_id)
        })
        .await?;
        executor.publish_agent_turn_event(waiting_event_id).await;
        drop(context_guard);

        let response = receiver.await.unwrap_or(ApprovalResponseInput {
            decision: "cancel".to_string(),
            reason: Some(
                "Environment operation channel closed before a decision was delivered.".to_string(),
            ),
        });
        environment_approvals.remove(&request.request_id).await;

        let mut context_guard = context.lock().await;
        let WorkspaceBrokerState { broker, .. } = &mut *context_guard;
        let request = executor
            .environment_repository()
            .get_request(request.project_root.clone(), request.request_id.clone())
            .await?
            .context("Environment operation request disappeared before approval resolution")?;
        if response.decision == "approve" {
            let current_project_root = executor
                .project_transition_repository()
                .active_project_root()
                .await?
                .unwrap_or_default()
                .replace('\\', "/");
            let current_snapshot_id =
                capture_environment_snapshot_id(session, &current_project_root, &executor)
                    .await
                    .ok();
            if let Some(reason) = environment_operation_stale_reason(
                &request,
                broker,
                &current_project_root,
                current_snapshot_id.as_deref(),
            ) {
                let stale_request_id = request.request_id.clone();
                let stale_decision = EnvironmentOperationDecisionRecord {
                    decision: "approve".to_string(),
                    status: "stale".to_string(),
                    reason: Some(reason.clone()),
                };
                let running_turn_id = turn_id.to_string();
                let stale_event = AgentTurnEventDraft {
                    turn_id: turn_id.to_string(),
                    event_type: "environment.stale".to_string(),
                    title: format!("Environment approval stale · {}", request.request_name),
                    body: Some(reason.clone()),
                    status: "error".to_string(),
                    tool: Some(tool),
                    request_id: Some(request.request_id.clone()),
                    code: None,
                    details_json: serde_json::to_string(&json!({"reason": reason}))?,
                };
                let stale_event_id = run_workspace_store_service(&executor, move |store| {
                    store
                        .decide_environment_operation_request(&stale_request_id, &stale_decision)?;
                    store.update_agent_turn_status(&running_turn_id, "running")?;
                    let event_id = store.append_agent_turn_event(&stale_event)?;
                    Ok(event_id)
                })
                .await?;
                executor.publish_agent_turn_event(stale_event_id).await;
                return Ok(json!({
                    "approved": false,
                    "request_id": request.request_id,
                    "decision": "stale",
                    "reason": reason,
                    "policy": "desktop_environment_review"
                }));
            }

            let approved_request_id = request.request_id.clone();
            let approved_decision = EnvironmentOperationDecisionRecord {
                decision: "approve".to_string(),
                status: "approved".to_string(),
                reason: response.reason.clone(),
            };
            let running_turn_id = turn_id.to_string();
            let approved_event = AgentTurnEventDraft {
                turn_id: turn_id.to_string(),
                event_type: "environment.approved".to_string(),
                title: format!("Environment approval granted · {}", request.request_name),
                body: Some("Broker authorized the reviewed environment operation.".to_string()),
                status: "completed".to_string(),
                tool: Some(tool),
                request_id: Some(request.request_id.clone()),
                code: None,
                details_json: serde_json::to_string(&json!({
                    "request_type": request_type,
                    "arguments": approved_arguments
                }))?,
            };
            let approved_event_id = run_workspace_store_service(&executor, move |store| {
                store.decide_environment_operation_request(
                    &approved_request_id,
                    &approved_decision,
                )?;
                store.update_agent_turn_status(&running_turn_id, "running")?;
                let event_id = store.append_agent_turn_event(&approved_event)?;
                Ok(event_id)
            })
            .await?;
            executor.publish_agent_turn_event(approved_event_id).await;
            approved_mutations.insert(
                request.request_id.clone(),
                ApprovedMutation {
                    request_type: request_type.clone(),
                    arguments: approved_arguments.clone(),
                },
            );
            return Ok(json!({
                "approved": true,
                "request_id": request.request_id,
                "approval_request_id": request.request_id,
                "decision": "approved",
                "reason": "Environment operation approved.",
                "policy": "desktop_environment_review",
                "request_type": request_type,
                "arguments": approved_arguments
            }));
        }

        let (status, body) = match response.decision.as_str() {
            "cancel" => (
                "cancelled",
                response
                    .reason
                    .clone()
                    .unwrap_or_else(|| "The environment operation was cancelled.".to_string()),
            ),
            _ => (
                "rejected",
                response
                    .reason
                    .clone()
                    .unwrap_or_else(|| "The environment operation was rejected.".to_string()),
            ),
        };
        let terminal_request_id = request.request_id.clone();
        let terminal_decision = EnvironmentOperationDecisionRecord {
            decision: response.decision.clone(),
            status: status.to_string(),
            reason: response.reason.clone(),
        };
        let running_turn_id = turn_id.to_string();
        let terminal_event = AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: format!("environment.{status}"),
            title: format!("Environment approval {status} · {}", request.request_name),
            body: Some(body.clone()),
            status: "error".to_string(),
            tool: Some(tool),
            request_id: Some(request.request_id.clone()),
            code: None,
            details_json: serde_json::to_string(&json!({
                "decision": response.decision,
                "reason": response.reason
            }))?,
        };
        let terminal_event_id = run_workspace_store_service(&executor, move |store| {
            store.decide_environment_operation_request(&terminal_request_id, &terminal_decision)?;
            store.update_agent_turn_status(&running_turn_id, "running")?;
            let event_id = store.append_agent_turn_event(&terminal_event)?;
            Ok(event_id)
        })
        .await?;
        executor.publish_agent_turn_event(terminal_event_id).await;
        return Ok(json!({
            "approved": false,
            "request_id": request.request_id,
            "decision": status,
            "reason": body,
            "policy": "desktop_environment_review"
        }));
    }

    let project_root = executor
        .project_transition_repository()
        .active_project_root()
        .await?
        .context("Cannot persist approval without an active project identity")?;
    let approval_draft = ApprovalRequestDraft {
        request_id: request_id.clone(),
        turn_id: turn_id.to_string(),
        project_root,
        tool: tool.clone(),
        policy: policy.clone(),
        arguments_json: serde_json::to_string(&arguments)?,
        code: code.clone(),
        workspace_id: identity.workspace_id.clone(),
        state_revision: identity.state_revision as i64,
        project_revision: identity.project_revision as i64,
    };
    run_workspace_store_service(&executor, move |store| {
        store.create_approval_request(&approval_draft)?;
        Ok(())
    })
    .await?;

    if auto_approve {
        let approved_request_id = request_id.clone();
        let approved_decision = ApprovalDecisionRecord {
            decision: "approve".to_string(),
            status: "approved".to_string(),
            reason: Some("Act session authorization enabled by the user.".to_string()),
            continuation_outcome: Some("execute".to_string()),
        };
        let running_turn_id = turn_id.to_string();
        let approved_event = AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: "approval.auto_approved".to_string(),
            title: format!("Act authorization granted · {tool}"),
            body: Some(
                "This Act session is authorized to execute R without repeated prompts.".to_string(),
            ),
            status: "completed".to_string(),
            tool: Some(tool.clone()),
            request_id: Some(request_id.clone()),
            code: code.clone(),
            details_json: serde_json::to_string(&json!({"policy": "act_session_authorized"}))?,
        };
        let approved_event_id = run_workspace_store_service(&executor, move |store| {
            store.resolve_approval_request(&approved_request_id, &approved_decision)?;
            store.update_agent_turn_status(&running_turn_id, "running")?;
            let event_id = store.append_agent_turn_event(&approved_event)?;
            Ok(event_id)
        })
        .await?;
        executor.publish_agent_turn_event(approved_event_id).await;
        approved_mutations.insert(
            request_id.clone(),
            ApprovedMutation {
                request_type: request_type.unwrap().to_string(),
                arguments,
            },
        );
        return Ok(json!({
            "approved": true,
            "request_id": request_id,
            "approval_request_id": request_id,
            "decision": "approved",
            "reason": "Act session authorization enabled by the user.",
            "policy": "act_session_authorized"
        }));
    }
    let receiver = approvals
        .register(request_id.clone(), Some(turn_id.to_string()))
        .await;
    let waiting_turn_id = turn_id.to_string();
    let waiting_event = AgentTurnEventDraft {
        turn_id: turn_id.to_string(),
        event_type: "approval.requested".to_string(),
        title: format!("Approval requested · {tool}"),
        body: Some("Workspace R remains unchanged until you approve this request.".to_string()),
        status: "running".to_string(),
        tool: Some(tool.clone()),
        request_id: Some(request_id.clone()),
        code: code.clone(),
        details_json: serde_json::to_string(&incoming.payload)?,
    };
    let waiting_event_id = run_workspace_store_service(&executor, move |store| {
        store.update_agent_turn_status(&waiting_turn_id, "waiting")?;
        let event_id = store.append_agent_turn_event(&waiting_event)?;
        Ok(event_id)
    })
    .await?;
    executor.publish_agent_turn_event(waiting_event_id).await;

    drop(context_guard);
    let response = receiver.await.unwrap_or(ApprovalResponseInput {
        decision: "cancel".to_string(),
        reason: Some("Approval channel closed before a decision was delivered.".to_string()),
    });
    approvals.remove(&request_id).await;

    let mut context_guard = context.lock().await;
    let WorkspaceBrokerState { broker, .. } = &mut *context_guard;
    let current = broker.identity();
    if response.decision == "approve"
        && (current.workspace_id != identity.workspace_id
            || current.state_revision as i64 != identity.state_revision as i64
            || current.project_revision as i64 != identity.project_revision as i64)
    {
        let reason = "Workspace state changed before approval was granted.".to_string();
        let stale_request_id = request_id.clone();
        let stale_decision = ApprovalDecisionRecord {
            decision: response.decision,
            status: "stale".to_string(),
            reason: Some(reason.clone()),
            continuation_outcome: Some("replan_required".to_string()),
        };
        let running_turn_id = turn_id.to_string();
        let stale_event = AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: "approval.stale".to_string(),
            title: format!("Approval stale · {tool}"),
            body: Some(reason.clone()),
            status: "error".to_string(),
            tool: Some(tool),
            request_id: Some(request_id.clone()),
            code,
            details_json: serde_json::to_string(&json!({"reason": reason}))?,
        };
        let stale_event_id = run_workspace_store_service(&executor, move |store| {
            store.resolve_approval_request(&stale_request_id, &stale_decision)?;
            store.update_agent_turn_status(&running_turn_id, "running")?;
            let event_id = store.append_agent_turn_event(&stale_event)?;
            Ok(event_id)
        })
        .await?;
        executor.publish_agent_turn_event(stale_event_id).await;
        return Ok(json!({
            "approved": false,
            "request_id": request_id,
            "decision": "stale",
            "reason": reason,
            "policy": "desktop_act_mode"
        }));
    }

    let (status, title, body, approved, continuation) = match response.decision.as_str() {
        "approve" => (
            "approved",
            format!("Approval granted · {tool}"),
            "Broker resumed the pending tool call.".to_string(),
            true,
            "execute",
        ),
        "cancel" => (
            "cancelled",
            format!("Approval cancelled · {tool}"),
            response
                .reason
                .clone()
                .unwrap_or_else(|| "The pending execution was cancelled.".to_string()),
            false,
            "approval_cancelled",
        ),
        _ => (
            "rejected",
            format!("Approval rejected · {tool}"),
            response
                .reason
                .clone()
                .unwrap_or_else(|| "The pending execution was rejected.".to_string()),
            false,
            "approval_rejected",
        ),
    };
    let terminal_request_id = request_id.clone();
    let terminal_decision = ApprovalDecisionRecord {
        decision: response.decision.clone(),
        status: status.to_string(),
        reason: response.reason.clone(),
        continuation_outcome: Some(continuation.to_string()),
    };
    let running_turn_id = turn_id.to_string();
    let terminal_event = AgentTurnEventDraft {
        turn_id: turn_id.to_string(),
        event_type: format!("approval.{status}"),
        title,
        body: Some(body.clone()),
        status: if approved {
            "completed".to_string()
        } else {
            "error".to_string()
        },
        tool: Some(tool),
        request_id: Some(request_id.clone()),
        code,
        details_json: serde_json::to_string(&json!({
            "decision": response.decision,
            "reason": response.reason,
            "continuation_outcome": continuation
        }))?,
    };
    let terminal_event_id = run_workspace_store_service(&executor, move |store| {
        store.resolve_approval_request(&terminal_request_id, &terminal_decision)?;
        store.update_agent_turn_status(&running_turn_id, "running")?;
        let event_id = store.append_agent_turn_event(&terminal_event)?;
        Ok(event_id)
    })
    .await?;
    executor.publish_agent_turn_event(terminal_event_id).await;
    if approved {
        approved_mutations.insert(
            request_id.clone(),
            ApprovedMutation {
                request_type: request_type.unwrap().to_string(),
                arguments,
            },
        );
    }
    Ok(json!({
        "approved": approved,
        "request_id": request_id,
        "approval_request_id": request_id,
        "decision": status,
        "reason": body,
        "policy": "desktop_act_mode"
    }))
}

async fn record_agent_turn_event(
    agent_store: &AgentRepository,
    turn_id: &str,
    payload: &Value,
) -> Result<()> {
    let Some(event) = project_agent_turn_event(turn_id, payload)? else {
        return Ok(());
    };
    agent_store.append_turn_event(event).await?;
    Ok(())
}

fn project_agent_turn_event(turn_id: &str, payload: &Value) -> Result<Option<AgentTurnEventDraft>> {
    let event_type = payload["type"].as_str().unwrap_or_default();
    let mapped = match event_type {
        "agent.run_started" => Some((
            "agent.run_started",
            "Agent started".to_string(),
            payload
                .get("tool_names")
                .and_then(Value::as_array)
                .map(|tools| {
                    format!(
                        "Tools available: {}",
                        tools
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }),
            "running".to_string(),
            None,
            None,
            None,
        )),
        "tool.call_started" => Some((
            "tool.call_started",
            format!(
                "Tool · {}",
                payload["tool"].as_str().unwrap_or("workspace_tool")
            ),
            Some("Running against Workspace R".to_string()),
            "running".to_string(),
            payload["tool"].as_str().map(str::to_string),
            None,
            payload
                .get("arguments")
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        "tool.call_completed" => Some((
            "tool.call_completed",
            format!(
                "Tool completed · {}",
                payload["tool"].as_str().unwrap_or("workspace_tool")
            ),
            payload["result_preview"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Some("Workspace result returned.".to_string())),
            "completed".to_string(),
            payload["tool"].as_str().map(str::to_string),
            None,
            payload
                .get("arguments")
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        "tool.call_failed" => Some((
            "tool.call_failed",
            format!(
                "Tool failed · {}",
                payload["tool"].as_str().unwrap_or("workspace_tool")
            ),
            payload["error"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Some("Tool execution failed.".to_string())),
            "error".to_string(),
            payload["tool"].as_str().map(str::to_string),
            None,
            payload
                .get("arguments")
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .map(str::to_string),
        )),
        "chat.message_completed" => Some((
            "chat.message_completed",
            "Rho".to_string(),
            event_message_text(payload),
            "completed".to_string(),
            None,
            None,
            None,
        )),
        "desktop.agent_completed" => Some((
            "desktop.agent_completed",
            "Agent completed".to_string(),
            Some("The turn finished without transport errors.".to_string()),
            "completed".to_string(),
            None,
            None,
            None,
        )),
        "desktop.agent_failed" => Some((
            "desktop.agent_failed",
            "Provider request failed".to_string(),
            Some(bounded_provider_failure(payload)),
            "error".to_string(),
            None,
            None,
            None,
        )),
        _ => None,
    };

    let details_json = if event_type == "desktop.agent_failed" {
        let mut bounded = payload.clone();
        bounded["error"] = Value::String(bounded_provider_failure(payload));
        serde_json::to_string(&bounded)?
    } else {
        serde_json::to_string(payload)?
    };
    Ok(mapped.map(
        |(event_type, title, body, status, tool, request_id, code)| AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: event_type.to_string(),
            title,
            body,
            status,
            tool,
            request_id,
            code,
            details_json: details_json.clone(),
        },
    ))
}

fn event_message_text(payload: &Value) -> Option<String> {
    payload
        .get("event")
        .and_then(|value| value.get("text").or_else(|| value.get("content")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("event")
                .and_then(|value| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn environment_operation_request_name(operation: &str) -> Result<&'static str> {
    match operation {
        "initialize" => Ok("environment.initialize"),
        "restore" => Ok("environment.restore"),
        "snapshot" => Ok("environment.snapshot"),
        "install_package" => Ok("environment.package_install"),
        "update_package" => Ok("environment.package_update"),
        "remove_package" => Ok("environment.package_remove"),
        _ => bail!("unsupported environment operation `{operation}`"),
    }
}
