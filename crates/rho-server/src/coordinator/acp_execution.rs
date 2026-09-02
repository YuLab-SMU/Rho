fn external_acp_context_profile() -> AgentRuntimeModelProfile {
    AgentRuntimeModelProfile {
        settings_revision: 1,
        route_capability: "external.acp".to_string(),
        profile_id: "external.acp".to_string(),
        provider_kind: "external_acp".to_string(),
        runtime_provider_id: "external.acp".to_string(),
        registered_provider_id: None,
        model_id: "agent_selected".to_string(),
        api_key_env: None,
        api_key_required: false,
        base_url: None,
        base_url_env: None,
        wire_api: Some("acp/1".to_string()),
        disable_stream_options: true,
        tool_calling: "agent_owned".to_string(),
        provider_display_name: "External ACP Agent".to_string(),
        model_display_name: "Agent selected".to_string(),
        context_window_tokens: 128 * 1024,
        reserved_output_tokens: 16 * 1024,
        context_capacity_source: "conservative_default".to_string(),
        capability_routes: Vec::new(),
        plugin_tools: Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn preview_external_acp_context_plan(
    prompt: &str,
    history: &[AgentConversationTurn],
    editor_context: Option<&Value>,
    project_root: Option<&str>,
    plugin_context: &[AgentPluginContextItem],
    explicit_context: Option<&AgentExplicitContextItem>,
    conversation_id: &str,
) -> Result<AgentContextPlanPreview> {
    let project_skills = project_root.map(discover_project_skills);
    let profile = external_acp_context_profile();
    let plan = plan_agent_context(
        prompt,
        history,
        editor_context,
        project_skills.as_ref(),
        plugin_context,
        explicit_context,
        &profile,
        "preview",
        conversation_id,
    )?;
    Ok(AgentContextPlanPreview {
        plan_digest: plan.digest,
        context_window_tokens: profile.context_window_tokens,
        reserved_output_tokens: profile.reserved_output_tokens,
        estimated_input_tokens: u64::try_from(plan.model_prompt.len()).unwrap_or(u64::MAX),
        capacity_source: profile.context_capacity_source,
        items: plan.receipts,
    })
}

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

#[allow(clippy::too_many_arguments)]
pub async fn run_external_acp_agent_turn(
    agent_store: AgentRepository,
    project_root: String,
    process_spec: rho_acp_client::AcpProcessSpec,
    prompt: String,
    turn_id: String,
    conversation_id: String,
    workspace_before: rho_protocol::WorkspaceIdentity,
    editor_context: Option<Value>,
    explicit_context: Option<AgentExplicitContextItem>,
    expected_plan_digest: Option<String>,
    plugin_context: Vec<AgentPluginContextItem>,
) -> Result<Value> {
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
        let profile = external_acp_context_profile();
        let plan = plan_agent_context(
            &prompt,
            &history,
            editor_context.as_ref(),
            project_skills.as_ref(),
            &plugin_context,
            explicit_context.as_ref(),
            &profile,
            &turn_id,
            &conversation_id,
        )?;
        if let Some(expected) = expected_plan_digest.as_deref() {
            ensure!(
                expected == plan.digest,
                "Agent context changed after review. Review the current context plan and send again."
            );
        }
        agent_store
            .record_context_items(project_root.clone(), turn_id.clone(), plan.receipts)
            .await?;

        let completion = rho_acp_client::run_external_acp_turn(process_spec, plan.model_prompt)
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
