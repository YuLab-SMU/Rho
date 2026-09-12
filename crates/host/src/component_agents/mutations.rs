//! Accepted mutations outlive the model future. Only their own native receipt is observed/cancelled.
use super::*;
use std::time::{Duration, Instant};

struct Work {
    host: Arc<NextHost>,
    owner: Arc<ComponentAgentOwner>,
    scope: ApplicationScope,
    context: CallContext,
    run: ComponentAgentRun,
    tool: StoredComponentTool,
    cancellation: CancellationToken,
    allow_dispatch: bool,
}

pub(super) async fn execute(
    port: &HostRunPort,
    tool: &StoredComponentTool,
    repeated: bool,
) -> Result<Value, ApplicationError> {
    if repeated && tool.receipt.phase == ComponentToolPhase::Resolved {
        return tool
            .receipt
            .result
            .clone()
            .ok_or_else(|| error("Resolved tool result is unavailable"));
    }
    if !repeated {
        port.owner.check_tool_dispatch(
            &port.scope,
            &port.run.run_id,
            &tool.receipt.receipt_id,
            now(),
        )?;
    }
    let work = Work {
        host: port.host.clone(),
        owner: port.owner.clone(),
        scope: port.scope.clone(),
        context: port.context.clone(),
        run: port.run.clone(),
        tool: tool.clone(),
        cancellation: port.cancellation.clone(),
        allow_dispatch: !repeated,
    };
    port.native_tasks
        .spawn(async move { work.run().await })
        .await
        .map_err(|_| error("Native tool tracking was interrupted"))?
}
impl Work {
    fn record(&self, update: ComponentToolUpdate) -> Result<StoredComponentTool, ApplicationError> {
        self.owner.record_tool(
            &self.scope,
            &self.run.run_id,
            &self.tool.receipt.receipt_id,
            update,
            now(),
        )
    }
    fn uncertain(&self, reason: impl Into<String>) -> Result<Value, ApplicationError> {
        self.record(ComponentToolUpdate::Uncertain {
            reason: reason.into(),
        })?
        .receipt
        .result
        .ok_or_else(|| error("Uncertain receipt was not retained"))
    }
    async fn run(&self) -> Result<Value, ApplicationError> {
        if let ComponentToolAction::Control(command) = &self.tool.action {
            return self.application(command).await;
        }
        let ComponentToolAction::Invoke(invocation) = &self.tool.action else {
            return Err(error("Unsupported mutation action"));
        };
        let mut record = match self
            .host
            .runtime
            .gateway
            .owner_request_record(&self.context, &self.tool.receipt.client_request_id)
            .await
        {
            Ok(Some(record)) => record,
            Err(_) => {
                return self
                    .uncertain("Original operation lookup failed; request was not replayed");
            }
            Ok(None) => {
                if !self.allow_dispatch {
                    return self.uncertain("Original intent has no confirmed operation; explicit reconciliation is required");
                }
                if self.cancellation.is_cancelled() {
                    return self.uncertain("Stopped before native dispatch");
                }
                self.owner.check_tool_dispatch(
                    &self.scope,
                    &self.run.run_id,
                    &self.tool.receipt.receipt_id,
                    now(),
                )?;
                match self
                    .host
                    .dispatch(
                        &self.context,
                        HostRequest::Invoke(InvokeRequest {
                            invocation: invocation.clone(),
                            return_after_acceptance: Some(true),
                        }),
                    )
                    .await
                {
                    Ok(value) => serde_json::from_value(value).map_err(error)?,
                    Err(failure) => {
                        match self
                            .host
                            .runtime
                            .gateway
                            .owner_request_record(
                                &self.context,
                                &self.tool.receipt.client_request_id,
                            )
                            .await
                        {
                            Ok(Some(record)) => record,
                            Ok(None) => {
                                return Ok(self
                                    .record(ComponentToolUpdate::Rejected {
                                        reason: failure.to_string(),
                                    })?
                                    .receipt
                                    .result
                                    .unwrap());
                            }
                            Err(_) => {
                                return self.uncertain(
                                    "Native admission is unconfirmed; request identity retained",
                                );
                            }
                        }
                    }
                }
            }
        };
        if record.operation.client_request_id != self.tool.receipt.client_request_id
            || record.operation.caller != self.context.caller
        {
            return self.uncertain("Native receipt does not match the original caller/request");
        }
        let id = record.operation.operation_id.clone();
        self.record(ComponentToolUpdate::Accepted {
            operation_id: Some(id.clone()),
            application_request_id: None,
        })?;
        let mut cancellation_started = None;
        let mut last_input_check = Instant::now() - Duration::from_secs(2);
        if !record.status.is_terminal() {
            self.owner.native_wait_state(
                &self.scope,
                &self.run.run_id,
                ComponentAgentRunState::WaitingForR,
                now(),
            )?;
        }
        loop {
            if record.status.is_terminal() {
                let value = present(&record)?;
                let mut evidence = vec![ComponentAgentEvidence::Operation {
                    operation_id: id.clone(),
                }];
                if let Some(output) = &record.output
                    && let Some(references) =
                        output.get("output_references").and_then(Value::as_array)
                {
                    for reference in references.iter().take(16) {
                        if let Ok(reference) = serde_json::from_value(reference.clone()) {
                            evidence.push(ComponentAgentEvidence::Media { reference });
                        }
                    }
                }
                self.record(ComponentToolUpdate::Resolved {
                    result: value.clone(),
                    evidence,
                })?;
                self.owner.native_wait_state(
                    &self.scope,
                    &self.run.run_id,
                    ComponentAgentRunState::Running,
                    now(),
                )?;
                return Ok(value);
            }
            if (self.cancellation.is_cancelled()
                || now()
                    >= self
                        .run
                        .created_at_ms
                        .saturating_add(self.run.budget.duration_ms))
                && cancellation_started.is_none()
            {
                cancellation_started = Some(Instant::now());
                let _ = self
                    .host
                    .dispatch(
                        &self.context,
                        HostRequest::RequestCancellation {
                            operation_id: id.clone(),
                            only_if_pending: Some(false),
                        },
                    )
                    .await;
            }
            if cancellation_started.is_some_and(|start| start.elapsed() > Duration::from_secs(20)) {
                return self
                    .uncertain("Cancellation is not confirmed; inspect the original operation");
            }
            if last_input_check.elapsed() >= Duration::from_secs(1)
                && let Some(session) = &self.run.request.grant.session
            {
                last_input_check = Instant::now();
                if let Ok(value)=self.host.dispatch(&self.context,HostRequest::QuerySnapshot(QueryRequest{capability:CapabilityRef::new("workspace.console_state",1).map_err(error)?,arguments:json!({"workspace_instance_id":session.workspace_instance_id})})).await {
                    let state=if value["data"].get("input").is_some_and(|input|!input.is_null()){ComponentAgentRunState::NeedsInput}else{ComponentAgentRunState::WaitingForR};
                    self.owner.native_wait_state(&self.scope,&self.run.run_id,state,now())?;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            match self
                .host
                .dispatch(
                    &self.context,
                    HostRequest::GetOperation {
                        operation_id: id.clone(),
                    },
                )
                .await
            {
                Ok(value) => match serde_json::from_value::<Option<OperationRecord>>(value) {
                    Ok(Some(observed)) => record = observed,
                    _ => {
                        return self
                            .uncertain("Original operation is unavailable; it was not replayed");
                    }
                },
                Err(_) => {
                    return self
                        .uncertain("Original operation observation failed; it was not replayed");
                }
            }
        }
    }
}

impl Work {
    async fn application(
        &self,
        command: &ApplicationCommandRequest,
    ) -> Result<Value, ApplicationError> {
        let owner = self.host.application_owner().map_err(error)?;
        let lookup = || {
            owner.command_status(
                &self.context,
                ApplicationCommandStatusArguments {
                    window: command.window.clone(),
                    request_id: command.request_id.clone(),
                },
                now(),
            )
        };
        let mut receipt =
            match lookup() {
                Ok(receipt) => receipt,
                Err(ApplicationError::NotFound) => {
                    if !self.allow_dispatch || self.cancellation.is_cancelled() {
                        return self.uncertain(
                            "Application intent was not submitted; no command was replayed",
                        );
                    }
                    self.owner.check_tool_dispatch(
                        &self.scope,
                        &self.run.run_id,
                        &self.tool.receipt.receipt_id,
                        now(),
                    )?;
                    match self
                        .host
                        .dispatch(
                            &self.context,
                            HostRequest::ApplicationControl(command.clone()),
                        )
                        .await
                    {
                        Ok(value) => serde_json::from_value(value).map_err(error)?,
                        Err(failure) => match lookup() {
                            Ok(receipt) => receipt,
                            Err(ApplicationError::NotFound) => {
                                return Ok(self
                                    .record(ComponentToolUpdate::Rejected {
                                        reason: failure.to_string(),
                                    })?
                                    .receipt
                                    .result
                                    .unwrap());
                            }
                            Err(_) => return self.uncertain(
                                "Application admission is unconfirmed; original request retained",
                            ),
                        },
                    }
                }
                Err(_) => {
                    return self
                        .uncertain("Application receipt is unavailable; command was not replayed");
                }
            };
        if receipt.request_id != self.tool.receipt.client_request_id
            || receipt.actor != self.context.caller
            || receipt.window != command.window
        {
            return self
                .uncertain("Application receipt does not match its original caller/request");
        }
        self.record(ComponentToolUpdate::Accepted {
            operation_id: None,
            application_request_id: Some(command.request_id.clone()),
        })?;
        let mut stopping = None;
        let mut cancelled = BTreeSet::new();
        loop {
            if matches!(
                receipt.state,
                ApplicationCommandState::Applied
                    | ApplicationCommandState::Failed
                    | ApplicationCommandState::Expired
                    | ApplicationCommandState::Cancelled
            ) && (!receipt
                .save
                .as_ref()
                .is_some_and(|s| s.state == ApplicationStepState::Succeeded)
                || receipt.save_synchronized == Some(true))
            {
                let value = serde_json::to_value(&receipt).map_err(error)?;
                let mut evidence = receipt
                    .applied_documents
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|document| ComponentAgentEvidence::Document { document })
                    .collect::<Vec<_>>();
                for step in [receipt.save.as_ref(), receipt.run.as_ref()]
                    .into_iter()
                    .flatten()
                {
                    if let Some(id) = &step.operation_id {
                        evidence.push(ComponentAgentEvidence::Operation {
                            operation_id: id.clone(),
                        });
                    }
                }
                self.record(ComponentToolUpdate::Resolved {
                    result: value.clone(),
                    evidence,
                })?;
                self.owner.native_wait_state(
                    &self.scope,
                    &self.run.run_id,
                    ComponentAgentRunState::Running,
                    now(),
                )?;
                return Ok(value);
            }
            if matches!(
                receipt.state,
                ApplicationCommandState::Uncertain
                    | ApplicationCommandState::LocallyAppliedUnsynced
            ) {
                return self.uncertain("Application changes or execution are unconfirmed; inspect the original command");
            }
            if self.cancellation.is_cancelled()
                || now()
                    >= self
                        .run
                        .created_at_ms
                        .saturating_add(self.run.budget.duration_ms)
            {
                if stopping.is_none() {
                    stopping = Some(Instant::now());
                    receipt = owner.cancel_command(
                        &self.context,
                        &command.window,
                        &command.request_id,
                        now(),
                    )?;
                }
                for step in [receipt.save.as_ref(), receipt.run.as_ref()]
                    .into_iter()
                    .flatten()
                {
                    let id = if let Some(id) = &step.operation_id {
                        Some(id.clone())
                    } else if step.state == ApplicationStepState::Submitting {
                        self.host
                            .runtime
                            .gateway
                            .owner_request_record(&self.context, &step.client_request_id)
                            .await
                            .ok()
                            .flatten()
                            .map(|r| r.operation.operation_id)
                    } else {
                        None
                    };
                    if let Some(id) = id
                        && cancelled.insert(id.clone())
                    {
                        let _ = self
                            .host
                            .dispatch(
                                &self.context,
                                HostRequest::RequestCancellation {
                                    operation_id: id,
                                    only_if_pending: Some(false),
                                },
                            )
                            .await;
                    }
                }
            }
            if stopping.is_some_and(|start| start.elapsed() > Duration::from_secs(20)) {
                return self
                    .uncertain("Application stop is unconfirmed; original receipts retained");
            }
            if receipt.state == ApplicationCommandState::AwaitingExecution && receipt.run.is_some()
            {
                self.owner.native_wait_state(
                    &self.scope,
                    &self.run.run_id,
                    ComponentAgentRunState::WaitingForR,
                    now(),
                )?;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            // The shared status query reconciles only already-submitted scientific steps.
            // A lost bridge response must not leave a finished operation permanently running.
            let snapshot = self
                .host
                .query_snapshot(
                    &self.context,
                    QueryRequest {
                        capability: CapabilityRef::new("application.command_status", 1)
                            .map_err(error)?,
                        arguments: json!({"window":command.window,"request_id":command.request_id}),
                    },
                )
                .await
                .map_err(error)?;
            receipt = serde_json::from_value(
                snapshot
                    .data
                    .ok_or_else(|| error("Application status is unavailable"))?,
            )
            .map_err(error)?;
        }
    }
}
fn present(record: &OperationRecord) -> Result<Value, ApplicationError> {
    let value = serde_json::to_value(record).map_err(error)?;
    if serde_json::to_vec(&value).map_err(error)?.len() <= 48 * 1024 {
        return Ok(value);
    }
    let mut failure = record.error.clone().unwrap_or_default();
    if failure.len() > 4096 {
        let mut end = 4096;
        while !failure.is_char_boundary(end) {
            end -= 1;
        }
        failure.truncate(end);
    }
    Ok(
        json!({"operation_id":record.operation.operation_id,"status":record.status,"error":failure,"output_omitted":true,
        "notice":"Large operation output remains with its original owner; read the operation/output references for details"}),
    )
}
