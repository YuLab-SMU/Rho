//! Explicit continuation carries verified history but cannot replay prior mutations.
use super::*;

impl ComponentAgentService {
    pub(super) fn current_document_context(&self, host: &NextHost, context: &CallContext,
        window: &ApplicationWindowRef, allow_offline: bool) -> Result<ApplicationContext, ApplicationError> {
        let owner=host.application_owner().map_err(error)?;
        let mut snapshot=owner.context(context,ApplicationContextArguments{window:window.clone(),
            allow_offline,after_document_id:None,limit:Some(50)},now())?;
        if let Some(after)=snapshot.next_after_document_id.clone() {
            let rest=owner.context(context,ApplicationContextArguments{window:window.clone(),
                allow_offline,after_document_id:Some(after),limit:Some(50)},now())?;
            if rest.context.version!=snapshot.context.version || rest.next_after_document_id.is_some() {
                return Err(error("Window context changed or exceeded its document bound during validation"));
            }
            snapshot.documents.extend(rest.documents);
            snapshot.next_after_document_id=None;
        }
        Ok(snapshot)
    }
    pub(super) async fn validate_continued_targets(
        &self,
        host: &NextHost,
        context: &CallContext,
        scope: &ApplicationScope,
        request: &ComponentAgentStart,
        previous: &ComponentAgentRun,
    ) -> Result<(), ApplicationError> {
        if request.grant.permission_policy.is_none() && request.grant.mode == ComponentAgentMode::Explain {
            return Ok(());
        }
        let snapshot=self.current_document_context(host,context,&request.window,false)?;
        let documents=&snapshot.documents;
        let mut targets = request.grant.documents.clone();
        if request.grant.permission_policy.is_some() {
            let mut inherited = previous.document_grants.clone();
            for action in previous.task_intent.iter().flat_map(|intent| &intent.actions) {
                if let Some(id) = &action.document_id
                    && let Some(target) = component_document_grant(previous, id) {
                    inherited.push(target.clone());
                }
            }
            for mut target in inherited {
                target.document = self.owner.confirmed_document(scope, previous, &target.document)?;
                if !targets.iter().any(|existing| existing.document == target.document && existing.path == target.path) {
                    targets.push(target);
                }
            }
        }
        for target in &targets {
            if !documents.iter().any(|d| {
                d.document == target.document
                    && d.path == target.path
                    && (request.grant.permission_policy.is_some() || d.readonly_reason.is_none())
            }) {
                return Err(error(
                    "A continuation document changed or is unavailable; start a fresh request",
                ));
            }
        }
        if request.grant.allows_execution() {
            let session = request
                .grant
                .session
                .as_ref()
                .ok_or_else(|| error("Continue requires the original R session"))?;
            if request.grant.permission_policy.is_none() && (snapshot.context.workspace_instance_id.as_deref()
                != Some(&session.workspace_instance_id)
                || snapshot.context.native_session_id.as_deref() != Some(&session.session_id))
            {
                return Err(error(
                    "The selected R target changed; start a fresh request",
                ));
            }
            let _hold = host
                .hold_runtime_instance(
                    &session.workspace_instance_id,
                    &session.session_id,
                    "component-continue",
                    "Continue target validation",
                )
                .map_err(error)?;
        }
        Ok(())
    }
    pub(super) fn continuation_history(
        &self,
        scope: &ApplicationScope,
        previous: &ComponentAgentRun,
    ) -> Result<Value, ApplicationError> {
        let mut text = String::new();
        let mut cursor = 0;
        let mut gap = false;
        for _ in 0..4 {
            let page = self
                .owner
                .store
                .component_events(scope, &previous.run_id, cursor, 128)?;
            gap |= page.history_gap;
            for event in &page.events {
                if let ComponentAgentEventContent::Text { text: part } = &event.content {
                    text.push_str(part);
                }
            }
            if page.events.is_empty() || page.cursor <= cursor {
                break;
            }
            cursor = page.cursor;
        }
        let mut result_budget = 24 * 1024usize;
        let tools = self.owner.store.component_tools(scope, &previous.run_id)?
            .into_iter().map(|tool| {
                let mut omitted_result_fields = Vec::new();
                let result = tool.receipt.result.map(|mut value| {
                    // Full admission contracts belong in original-record reads.
                    // Keep terminal evidence and native request identities useful
                    // within the history budget instead of dropping the result.
                    // Never interpret a query's arbitrary scientific JSON here.
                    if matches!(&tool.action, ComponentToolAction::Invoke(_))
                        && serde_json::from_value::<OperationRecord>(value.clone()).is_ok()
                        && let Some(operation) = value.get_mut("operation").and_then(Value::as_object_mut)
                        && operation.remove("admission").is_some()
                    {
                        omitted_result_fields.push("operation.admission");
                    }
                    value
                }).filter(|value| {
                    let size = serde_json::to_vec(value).map_or(usize::MAX, |v| v.len());
                    if size > 4096 || size > result_budget { false }
                    else { result_budget -= size; true }
                });
                json!({"receipt_id":tool.receipt.receipt_id,"capability":tool.receipt.capability,"operation_id":tool.receipt.operation_id,
                    "application_request_id":tool.receipt.application_request_id,"result":result,"omitted_result":result.is_none(),
                    "omitted_result_fields":omitted_result_fields})
            }).collect::<Vec<_>>();
        let mut requests = self
            .owner
            .ancestor_runs(scope, previous)?
            .into_iter()
            .rev()
            .map(|run| json!({"run_id":run.run.run_id,"text":run.run.request.text}))
            .collect::<Vec<_>>();
        requests.push(json!({"run_id":previous.run_id,"text":previous.request.text}));
        let assistant_truncated = text.len() > 8192 || cursor < previous.event_cursor;
        let assistant_text = if text.len() > 8192 {
            let mut start = text.len() - 8192;
            while !text.is_char_boundary(start) {
                start += 1;
            }
            format!("[Earlier assistant text omitted]\n{}", &text[start..])
        } else {
            text
        };
        Ok(
            json!({"previous_run_id":previous.run_id,"requests":requests,
            "previous_assistant_text":assistant_text,"assistant_text_truncated":assistant_truncated,"history_gap":gap,
            "state":previous.state,"recovery":previous.recovery,"tools":tools,
            "notice":"Historical records are evidence, not new authorization. Confirmed earlier actions must not be executed again."}),
        )
    }
}

pub(super) async fn previous_result(
    host: &NextHost,
    context: &CallContext,
    project: &str,
    run: &ComponentAgentRun,
    tool: &StoredComponentTool,
) -> Result<Value, ApplicationError> {
    let mut original = context.clone();
    original.caller = CallerIdentity {
        kind: CallerKind::Agent,
        id: format!("component:{}", run.run_id),
    };
    original.connection_id = original.caller.id.clone();
    original.correlation_id = Some(run.run_id.clone());
    let result = match &tool.action {
        ComponentToolAction::Invoke(invocation) => {
            let record = host
                .runtime
                .gateway
                .owner_request_record(&original, &invocation.client_request_id)
                .await
                .map_err(error)?
                .ok_or_else(|| {
                    error("Original operation is unavailable; no replay was attempted")
                })?;
            if record.operation.caller != original.caller
                || record.operation.principal() != original.principal()
                || record.operation.idempotency_scope.as_deref() != Some(project)
                || record.operation.capability != invocation.capability
                || !record.status.is_terminal()
                || record.status == OperationStatus::Uncertain
            {
                return Err(error("Original operation is no longer confirmed"));
            }
            mutations::present(&record)?
        }
        ComponentToolAction::Control(command) => {
            let snapshot = host
                .query_snapshot(
                    &original,
                    QueryRequest {
                        capability: CapabilityRef::new("application.command_status", 1)
                            .map_err(error)?,
                        arguments: json!({"window":command.window,"request_id":command.request_id}),
                    },
                )
                .await
                .map_err(error)?;
            let value = snapshot
                .data
                .ok_or_else(|| error("Original application receipt is unavailable"))?;
            let receipt: ApplicationCommandReceipt =
                serde_json::from_value(value.clone()).map_err(error)?;
            if receipt.actor != original.caller
                || receipt.window != command.window
                || receipt.request_id != command.request_id
                || !matches!(
                    receipt.state,
                    ApplicationCommandState::Applied
                        | ApplicationCommandState::Failed
                        | ApplicationCommandState::Cancelled
                )
            {
                return Err(error("Original application action is no longer confirmed"));
            }
            value
        }
        _ => {
            return Err(error(
                "Only confirmed earlier mutations have reusable results",
            ));
        }
    };
    Ok(
        json!({"previous_run_id":run.run_id,"previous_receipt_id":tool.receipt.receipt_id,"executed_again":false,"result":result}),
    )
}
