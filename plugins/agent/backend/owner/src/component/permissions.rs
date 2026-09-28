//! Durable task interpretation and permission replies; no model or approval heuristics.
use super::*;

/// A display summary of the already bound action, never a permission decision.
fn action_title(run: &ComponentAgentRun, action: &ComponentToolAction) -> String {
    let document_name = |document: &ApplicationDocumentRef| {
        component_document_grant(run, &document.document_id)
            .and_then(|grant| grant.path.as_deref())
            .unwrap_or("the selected document")
            .to_owned()
    };
    let session_name = |target: Option<&str>| match target.or_else(|| {
        run.request
            .grant
            .session
            .as_ref()
            .map(|session| session.workspace_instance_id.as_str())
    }) {
        Some("main") => "Main".to_owned(),
        Some(id) => id.to_owned(),
        None => "the selected R session".to_owned(),
    };
    match action {
        ComponentToolAction::Control(command) => {
            let session = || {
                session_name(
                    command
                        .execution_target
                        .as_ref()
                        .map(|target| target.workspace_instance_id.as_str()),
                )
            };
            match &command.action {
                ApplicationAction::CreateDocument { path, .. } => format!(
                    "Create {}",
                    path.as_deref().unwrap_or("an untitled document")
                ),
                ApplicationAction::OpenDocument { path, .. } => format!("Open {path}"),
                ApplicationAction::EditDocument { document, .. } => {
                    format!("Edit {}", document_name(document))
                }
                ApplicationAction::Save {
                    document,
                    target_path,
                } => format!(
                    "Save {}",
                    target_path
                        .clone()
                        .unwrap_or_else(|| document_name(document))
                ),
                ApplicationAction::RunFile {
                    document,
                    target_path,
                } => format!(
                    "Save and run {} in {}",
                    target_path
                        .clone()
                        .unwrap_or_else(|| document_name(document)),
                    session()
                ),
                ApplicationAction::RunSelection { document } => format!(
                    "Run selection from {} in {}",
                    document_name(document),
                    session()
                ),
                _ => "Update the workspace view".into(),
            }
        }
        ComponentToolAction::Invoke(invocation) => {
            let session = session_name(
                invocation
                    .arguments
                    .get("workspace_instance_id")
                    .and_then(Value::as_str),
            );
            match invocation.capability.id.as_str() {
                "workspace.run_r" => format!("Run R code in {session}"),
                "workspace.resume_queue" => format!("Continue queued R work in {session}"),
                _ => "Perform the requested project action".into(),
            }
        }
        _ => "Read the selected context".into(),
    }
}

impl ComponentAgentOwner {
    pub fn capture_task_intent(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        intent: &ComponentAgentTaskIntent,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        policy::validate_task_intent(&run.run, intent)?;
        if run.run.task_intent.as_ref() == Some(intent) {
            return Ok(());
        }
        run.run.task_intent = Some(intent.clone());
        run.run.updated_at_ms = now;
        self.save(scope, conversation, Some(&run), &[], &[], now)
    }

    pub fn record_permission(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        receipt_id: &str,
        tool_name: &str,
        authorization: ComponentTaskAuthorization,
        allowed: bool,
        now: u64,
    ) -> Result<ComponentAgentPermission, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        if let Some(existing) = run
            .run
            .permissions
            .iter()
            .find(|p| p.receipt_id == receipt_id)
        {
            return Ok(existing.clone());
        }
        if run.run.state != ComponentAgentRunState::Running || run.run.task_intent.is_none() {
            return Err(invalid(
                "Record the user's task intent before requesting an action",
            ));
        }
        let tool = self
            .store
            .component_tools(scope, run_id)?
            .into_iter()
            .find(|t| t.receipt.receipt_id == receipt_id)
            .ok_or(ApplicationError::NotFound)?;
        if !tool.action.mutation() || tool.receipt.phase != ComponentToolPhase::Intent {
            return Err(ApplicationError::Conflict);
        }
        let permission = ComponentAgentPermission {
            decision_id: uuid::Uuid::new_v4().to_string(),
            receipt_id: receipt_id.into(),
            action_digest: tool.receipt.action_digest.clone(),
            tool: tool_name.into(),
            title: action_title(&run.run, &tool.action),
            // The full immutable action already lives in its durable tool
            // record. Only the one pending decision needs a second UI copy.
            details: if allowed {
                String::new()
            } else {
                serde_json::to_string_pretty(&tool.action).map_err(storage)?
            },
            authorization,
            policy: run
                .run
                .request
                .grant
                .permission_policy
                .ok_or(ApplicationError::Conflict)?,
            state: if allowed {
                ComponentPermissionState::Allowed
            } else {
                ComponentPermissionState::Pending
            },
        };
        run.run.permissions.push(permission.clone());
        run.run.updated_at_ms = now;
        let mut events = Vec::new();
        if !allowed {
            run.run.state = ComponentAgentRunState::WaitingForPermission;
            run.run.event_cursor += 1;
            events.push(ComponentAgentEvent {
                run_id: run_id.into(),
                sequence: run.run.event_cursor,
                created_at_ms: now,
                content: ComponentAgentEventContent::State {
                    state: run.run.state,
                    reason: Some("Waiting for permission for an additional action".into()),
                },
            });
        }
        self.save(scope, conversation, Some(&run), &[], &events, now)?;
        Ok(permission)
    }

    pub fn decide_permission(
        &self,
        actor: &ComponentActor,
        run_id: &str,
        decision_id: &str,
        allow: bool,
        now: u64,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        let saved = self
            .store
            .component_run(actor.scope(), run_id)?
            .ok_or(ApplicationError::NotFound)?;
        self.conversation(actor, &saved.run.request.conversation_id)?;
        let wanted = if allow {
            ComponentPermissionState::Allowed
        } else {
            ComponentPermissionState::Denied
        };
        let original = saved
            .run
            .permissions
            .iter()
            .find(|p| p.decision_id == decision_id)
            .ok_or(ApplicationError::NotFound)?;
        if original.state != ComponentPermissionState::Pending {
            if original.state == wanted {
                return Ok(saved.run);
            }
            return Err(ApplicationError::RequestConflict);
        }
        let (conversation, mut run) = self.active(actor.scope(), run_id, now)?;
        if run.run.state != ComponentAgentRunState::WaitingForPermission {
            return Err(ApplicationError::Conflict);
        }
        let permission = run
            .run
            .permissions
            .iter_mut()
            .find(|p| p.decision_id == decision_id)
            .unwrap();
        let mut tool = self
            .store
            .component_tools(actor.scope(), run_id)?
            .into_iter()
            .find(|t| t.receipt.receipt_id == permission.receipt_id)
            .ok_or(ApplicationError::NotFound)?;
        if tool.receipt.phase != ComponentToolPhase::Intent
            || tool.receipt.action_digest != permission.action_digest
        {
            return Err(ApplicationError::Conflict);
        }
        permission.state = wanted;
        permission.details.clear();
        if !allow {
            tool.receipt.phase = ComponentToolPhase::Resolved;
            tool.receipt.result = Some(serde_json::json!({"status":"rejected","accepted":false,
                "error":"The user declined this additional action. Continue without performing it."}));
            tool.receipt.updated_at_ms = now;
        }
        run.run.state = ComponentAgentRunState::Running;
        run.run.updated_at_ms = now;
        run.run.event_cursor += 1;
        let event = ComponentAgentEvent {
            run_id: run_id.into(),
            sequence: run.run.event_cursor,
            created_at_ms: now,
            content: ComponentAgentEventContent::State {
                state: run.run.state,
                reason: None,
            },
        };
        self.save(
            actor.scope(),
            conversation,
            Some(&run),
            &[tool],
            &[event],
            now,
        )?;
        Ok(run.run)
    }
}
