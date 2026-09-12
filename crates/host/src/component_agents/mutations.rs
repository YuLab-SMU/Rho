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
                return self.uncertain("Original operation lookup failed; request was not replayed");
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
