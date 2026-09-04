fn acp_event_draft(turn_id: &str, event: &rho_acp_client::AcpClientEvent) -> AgentTurnEventDraft {
    let (event_type, title, body, status, tool) = match event {
        rho_acp_client::AcpClientEvent::MessageDelta { text } => (
            "chat.message_delta",
            "External Agent response",
            Some(text.clone()),
            "running",
            None,
        ),
        rho_acp_client::AcpClientEvent::ToolCall { payload } => (
            "provider.tool_requested",
            "External Agent tool",
            None,
            "running",
            payload
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        rho_acp_client::AcpClientEvent::ToolCallUpdate { payload } => (
            "provider.tool_updated",
            "External Agent tool update",
            None,
            "running",
            payload
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        rho_acp_client::AcpClientEvent::Plan { .. } => (
            "provider.plan_updated",
            "External Agent plan",
            None,
            "running",
            None,
        ),
        rho_acp_client::AcpClientEvent::ModeChanged { .. } => (
            "provider.mode_changed",
            "External Agent mode",
            None,
            "completed",
            None,
        ),
        rho_acp_client::AcpClientEvent::ConfigChanged { .. } => (
            "provider.config_changed",
            "External Agent configuration",
            None,
            "completed",
            None,
        ),
        rho_acp_client::AcpClientEvent::SessionInfoChanged { .. } => (
            "provider.session_changed",
            "External Agent session",
            None,
            "completed",
            None,
        ),
    };
    AgentTurnEventDraft {
        turn_id: turn_id.to_string(),
        event_type: event_type.to_string(),
        title: title.to_string(),
        body,
        status: status.to_string(),
        tool,
        request_id: None,
        code: None,
        details_json: serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string()),
    }
}

pub async fn run_external_acp_agent_turn(
    agent_store: AgentRepository,
    process_spec: rho_acp_client::AcpProcessSpec,
    client_exposure: rho_acp_client::AcpClientExposure,
    prompt: String,
    turn_id: String,
    conversation_id: String,
    workspace_before: rho_protocol::WorkspaceIdentity,
) -> Result<Value> {
    let result = async {
        let completion = rho_acp_client::run_external_acp_turn_with_exposure(
            process_spec,
            prompt,
            None,
            client_exposure,
        )
        .await
        .context("external ACP Agent turn failed")?;
        for event in &completion.events {
            agent_store
                .append_turn_event(acp_event_draft(&turn_id, event))
                .await?;
        }
        if !completion.final_text.is_empty() {
            agent_store
                .append_turn_event(AgentTurnEventDraft {
                    turn_id: turn_id.clone(),
                    event_type: "chat.message_completed".to_string(),
                    title: "External Agent".to_string(),
                    body: Some(completion.final_text.clone()),
                    status: "completed".to_string(),
                    tool: None,
                    request_id: None,
                    code: None,
                    details_json: serde_json::to_string(&json!({
                        "session_id": completion.session_id,
                        "stop_reason": completion.stop_reason,
                        "permission_requests_denied": completion.permission_requests_denied,
                        "permission_requests_selected": completion.permission_requests_selected,
                        "workspace_file_reads": completion.workspace_file_reads,
                        "workspace_file_writes": completion.workspace_file_writes,
                        "terminal_commands_created": completion.terminal_commands_created,
                    }))?,
                })
                .await?;
        }
        agent_store
            .finish_turn(AgentTurnFinish {
                turn_id: turn_id.clone(),
                status: "completed".to_string(),
                terminal_reason: Some("external_acp_completed".to_string()),
                workspace_id_after: Some(workspace_before.workspace_id.clone()),
                state_revision_after: Some(workspace_before.state_revision as i64),
                project_revision_after: Some(workspace_before.project_revision as i64),
                final_message: Some(completion.final_text.clone()),
                error_message: None,
            })
            .await?;
        Ok(json!({
            "turn_id": turn_id,
            "conversation_id": conversation_id,
            "provider": "external_acp",
            "session_id": completion.session_id,
            "stop_reason": completion.stop_reason,
            "permission_requests_denied": completion.permission_requests_denied,
            "permission_requests_selected": completion.permission_requests_selected,
            "workspace_file_reads": completion.workspace_file_reads,
            "workspace_file_writes": completion.workspace_file_writes,
            "terminal_commands_created": completion.terminal_commands_created,
            "status": "completed"
        }))
    }
    .await;

    if let Err(error) = &result {
        agent_store
            .finish_turn(AgentTurnFinish {
                turn_id,
                status: "failed".to_string(),
                terminal_reason: Some("external_acp_failure".to_string()),
                workspace_id_after: Some(workspace_before.workspace_id.clone()),
                state_revision_after: Some(workspace_before.state_revision as i64),
                project_revision_after: Some(workspace_before.project_revision as i64),
                final_message: None,
                error_message: Some(redact_sensitive_text(&error.to_string())),
            })
            .await?;
    }
    result
}
