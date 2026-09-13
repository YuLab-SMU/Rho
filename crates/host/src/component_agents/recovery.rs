//! Explicit reconciliation reads original owners; it never invokes or cancels work.
use super::*;

fn status(record: &OperationRecord) -> ComponentRecoveryState {
    match record.status {
        OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled => {
            ComponentRecoveryState::Confirmed
        }
        OperationStatus::Uncertain => ComponentRecoveryState::Uncertain,
        _ => ComponentRecoveryState::Pending,
    }
}
fn same_owner(
    record: &OperationRecord,
    context: &CallContext,
    project: &str,
    request: &str,
) -> bool {
    record.operation.caller == context.caller
        && record.operation.principal() == context.principal()
        && record.operation.idempotency_scope.as_deref() == Some(project)
        && record.operation.client_request_id == request
}
fn uncertain(entry: &mut ComponentRecoveredTool, note: &str) {
    entry.state = ComponentRecoveryState::Uncertain;
    entry.note = Some(note.into());
}
impl ComponentAgentService {
    /// Serialize observation against admission/finalization so a persisted intent
    /// cannot be mistaken for a missing runner while start is still registering it.
    pub async fn observe_run(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        id: &str,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        let _gate = self.gate.lock().await;
        let stored = self
            .owner
            .store
            .component_run(&Self::scope(host, context, project)?, id)?
            .ok_or(ApplicationError::NotFound)?;
        let mut run = self.owner.observed_run(stored);
        if !run.state.is_terminal() && !self.live.lock().await.contains_key(id) {
            run.state = ComponentAgentRunState::Interrupted;
            run.reason = Some(
                "The Host has no live task for this request; reconcile the original tool records"
                    .into(),
            );
        }
        Ok(run)
    }
    pub async fn observe_request(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        id: &str,
    ) -> Result<Option<ComponentAgentRun>, ApplicationError> {
        let original = self.run_by_request(host, context, project, id)?;
        match original {
            Some(run) => self
                .observe_run(host, context, project, &run.run_id)
                .await
                .map(Some),
            None => Ok(None),
        }
    }
    pub async fn run_history(
        &self,
        host: &NextHost,
        context: &CallContext,
        request: ComponentAgentsQuery,
    ) -> Result<Vec<ComponentAgentRunSummary>, ApplicationError> {
        let ComponentAgentQuery::Runs { conversation_id, before, limit } = request.query else {
            return Err(error("Expected a run history query"));
        };
        let _gate = self.gate.lock().await;
        let rows = self.owner.store.component_run_history(
            &Self::scope(host, context, &request.project_root)?, &conversation_id, before.as_deref(), limit as usize)?;
        let live = self.live.lock().await;
        Ok(rows.into_iter().map(|(mut summary, incarnation)| {
            if !summary.state.is_terminal() {
                if incarnation != self.owner.host_incarnation {
                    summary.state = ComponentAgentRunState::Interrupted;
                    summary.reason = Some("The previous Host no longer owns this request; reconcile its original tool records".into());
                } else if !live.contains_key(&summary.run_id) {
                    summary.state = ComponentAgentRunState::Interrupted;
                    summary.reason = Some("The Host has no live task for this request; reconcile the original tool records".into());
                }
            }
            summary
        }).collect())
    }
    pub async fn take_control(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        conversation: &str,
        expected_version: u64,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        let _gate = self.gate.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(error("Component service is closing"));
        }
        let actor = Self::actor(host, context, project, window)?;
        let original = self
            .owner
            .store
            .component_conversation(actor.scope(), conversation)?
            .ok_or(ApplicationError::NotFound)?;
        if let Some(id) = original.active_run_id
            && self.live.lock().await.contains_key(&id)
        {
            return Err(error(
                "The current request still has a live Host task; stop or wait before taking control",
            ));
        }
        self.owner
            .take_control(&actor, conversation, expected_version, now())
    }

    pub async fn reconcile(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        id: &str,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        let _gate = self.gate.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(error("Component service is closing"));
        }
        let actor = Self::actor(host, context, project, window)?;
        if self.live.lock().await.contains_key(id) {
            return Err(error(
                "This request still has a live Host task; observe its existing run",
            ));
        }
        let run = self.owner.interrupt_abandoned(actor.scope(), id, now())?;
        let tools = self.owner.store.component_tools(actor.scope(), id)?;
        let mut native = context.clone();
        native.principal = Some(context.principal().clone());
        native.caller = CallerIdentity {
            kind: CallerKind::Agent,
            id: format!("component:{id}"),
        };
        native.connection_id = format!("component:{id}");
        native.correlation_id = Some(id.into());
        let mut observations = Vec::new();
        for tool in tools {
            let mut entry = ComponentRecoveredTool {
                receipt_id: tool.receipt.receipt_id.clone(),
                state: ComponentRecoveryState::ReadInterrupted,
                application_request_id: tool.receipt.application_request_id.clone(),
                application_state: None,
                operations: vec![],
                documents: vec![],
                note: None,
            };
            match &tool.action {
                ComponentToolAction::Query(_) | ComponentToolAction::Rejected { .. } | ComponentToolAction::PreviousResult { .. } => {
                    if tool.receipt.phase == ComponentToolPhase::Resolved {
                        entry.state = ComponentRecoveryState::Confirmed;
                    } else {
                        entry.note=Some("No retained read result; a future request may perform a fresh observation".into());
                    }
                }
                ComponentToolAction::Invoke(invocation) => {
                    match host
                        .runtime
                        .gateway
                        .owner_request_record(&native, &invocation.client_request_id)
                        .await
                    {
                        Ok(Some(record))
                            if same_owner(
                                &record,
                                &native,
                                project,
                                &invocation.client_request_id,
                            ) && record.operation.capability == invocation.capability
                                && tool
                                    .receipt
                                    .operation_id
                                    .as_ref()
                                    .is_none_or(|id| id == &record.operation.operation_id) =>
                        {
                            entry.state = status(&record);
                            entry.operations.push(ComponentRecoveredOperation {
                                operation_id: record.operation.operation_id,
                                status: record.status,
                            });
                        }
                        Ok(None) if tool.receipt.operation_id.is_none() => {
                            entry.state = ComponentRecoveryState::NotSubmitted;
                            entry.note=Some("The owner has no accepted request with the original caller and request ID; nothing was resubmitted".into());
                        }
                        _ => uncertain(
                            &mut entry,
                            "The original scientific receipt is missing, unavailable or mismatched",
                        ),
                    }
                }
                ComponentToolAction::Control(command) => {
                    let args = ApplicationCommandStatusArguments {
                        window: command.window.clone(),
                        request_id: command.request_id.clone(),
                    };
                    match host.application_owner().map_err(error)?.command_status(
                        &native,
                        args,
                        now(),
                    ) {
                        Err(ApplicationError::NotFound)
                            if tool.receipt.application_request_id.is_none() =>
                        {
                            entry.state = ComponentRecoveryState::NotSubmitted;
                            entry.note=Some("The Application owner has no accepted original command; nothing was replayed".into());
                        }
                        Err(_) => uncertain(
                            &mut entry,
                            "The original application command is unavailable",
                        ),
                        Ok(_) => {
                            // This shared query only reconciles steps that were already submitted.
                            let snapshot=host.query_snapshot(&native,QueryRequest{capability:CapabilityRef::new("application.command_status",1).map_err(error)?,
                                arguments:json!({"window":command.window,"request_id":command.request_id})}).await;
                            let receipt = snapshot.ok().and_then(|s| s.data).and_then(|value| {
                                serde_json::from_value::<ApplicationCommandReceipt>(value).ok()
                            });
                            match receipt {
                                Some(receipt)
                                    if receipt.request_id == command.request_id
                                        && receipt.window == command.window
                                        && receipt.actor == native.caller =>
                                {
                                    entry.application_request_id = Some(command.request_id.clone());
                                    entry.application_state = Some(receipt.state);
                                    let target = match &command.action {
                                        ApplicationAction::EditDocument { document, .. }
                                        | ApplicationAction::Save { document, .. }
                                        | ApplicationAction::RunFile { document, .. }
                                        | ApplicationAction::RunSelection { document } => {
                                            Some(&document.document_id)
                                        }
                                        _ => None,
                                    };
                                    entry.documents = receipt
                                        .applied_documents
                                        .clone()
                                        .unwrap_or_default()
                                        .into_iter()
                                        .filter(|d| Some(&d.document_id) == target)
                                        .collect();
                                    entry.state = match receipt.state {
                                        ApplicationCommandState::Applied
                                        | ApplicationCommandState::Failed
                                        | ApplicationCommandState::Cancelled => {
                                            ComponentRecoveryState::Confirmed
                                        }
                                        ApplicationCommandState::Expired => {
                                            ComponentRecoveryState::NotSubmitted
                                        }
                                        ApplicationCommandState::LocallyAppliedUnsynced
                                        | ApplicationCommandState::Uncertain => {
                                            ComponentRecoveryState::Uncertain
                                        }
                                        _ => ComponentRecoveryState::Pending,
                                    };
                                    if receipt
                                        .save
                                        .as_ref()
                                        .is_some_and(|s| s.state == ApplicationStepState::Succeeded)
                                        && receipt.save_synchronized != Some(true)
                                    {
                                        uncertain(
                                            &mut entry,
                                            "Saving is confirmed but the editor's successor version is not acknowledged",
                                        );
                                    }
                                    for (step, expected_capability) in [
                                        (receipt.save.as_ref(), "project.apply_patch"),
                                        (receipt.run.as_ref(), "workspace.run_r"),
                                    ]
                                    .into_iter()
                                    .filter_map(|(step, capability)| {
                                        step.map(|step| (step, capability))
                                    }) {
                                        if step.operation_id.is_none()
                                            && matches!(
                                                step.state,
                                                ApplicationStepState::NotSubmitted
                                                    | ApplicationStepState::Cancelled
                                                    | ApplicationStepState::Failed
                                            )
                                        {
                                            continue;
                                        }
                                        if step.operation_id.is_none()
                                            && step.verification.is_some()
                                        {
                                            continue;
                                        }
                                        match host
                                            .runtime
                                            .gateway
                                            .owner_request_record(&native, &step.client_request_id)
                                            .await
                                        {
                                            Ok(Some(record))
                                                if same_owner(
                                                    &record,
                                                    &native,
                                                    project,
                                                    &step.client_request_id,
                                                ) && record.operation.capability.id == expected_capability
                                                    && record.operation.capability.version == 1
                                                    && step.operation_id.as_ref().is_none_or(
                                                    |id| id == &record.operation.operation_id,
                                                ) =>
                                            {
                                                if status(&record)
                                                    == ComponentRecoveryState::Uncertain
                                                {
                                                    uncertain(
                                                        &mut entry,
                                                        "A scientific step remains uncertain",
                                                    );
                                                } else if status(&record)
                                                    == ComponentRecoveryState::Pending
                                                    && entry.state
                                                        != ComponentRecoveryState::Uncertain
                                                {
                                                    entry.state = ComponentRecoveryState::Pending;
                                                }
                                                entry.operations.push(
                                                    ComponentRecoveredOperation {
                                                        operation_id: record.operation.operation_id,
                                                        status: record.status,
                                                    },
                                                );
                                            }
                                            Ok(None)
                                                if step.operation_id.is_none()
                                                    && step.state
                                                        == ApplicationStepState::Submitting =>
                                            {
                                                if entry.state != ComponentRecoveryState::Uncertain
                                                {
                                                    entry.state = ComponentRecoveryState::Pending;
                                                }
                                            }
                                            _ => uncertain(
                                                &mut entry,
                                                "A linked scientific step is missing, unavailable or mismatched",
                                            ),
                                        }
                                    }
                                }
                                _ => uncertain(
                                    &mut entry,
                                    "The original application receipt could not be verified",
                                ),
                            }
                        }
                    }
                }
            }
            observations.push(entry);
        }
        self.owner
            .record_recovery(actor.scope(), &run.run.run_id, observations, now())
    }
}
