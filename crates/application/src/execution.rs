use super::*;
use serde_json::json;

/// Host alone consumes this; it is deliberately not a wire DTO.
pub enum ApplicationExecutionAdmission {
    Invoke {
        context: CallContext,
        invocation: Invocation,
    },
    Observe {
        lookup: ApplicationOperationLookup,
    },
    VerifySaved {
        context: CallContext,
        path: String,
        sha256: String,
    },
}
#[derive(Clone)]
pub struct ApplicationOperationLookup {
    pub context: CallContext,
    pub client_request_id: String,
    pub operation_id: Option<OperationId>,
}

impl ApplicationOwner {
    /// Called with the Application lock held after the editor synchronizes its save result.
    /// Acknowledgement cannot grant authority over typing that happened during the save.
    pub(crate) fn confirm_saved_document(
        &self,
        scope: &ApplicationScope,
        window: &mut StoredWindow,
        request_id: &str,
        execution_ref: &str,
        reference: &ApplicationDocumentRef,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let mut command = self
            .store
            .command(scope, &window.window.window_id, request_id)?
            .ok_or(ApplicationError::NotFound)?;
        if command.request.window != window.window
            || command.execution_ref.as_deref() != Some(execution_ref)
            || !command
                .receipt
                .save
                .as_ref()
                .is_some_and(|s| s.state == ApplicationStepState::Succeeded)
        {
            return Err(ApplicationError::Conflict);
        }
        if command.receipt.save_synchronized == Some(true) {
            return Ok(command.receipt);
        }
        let capture = command
            .capture
            .as_ref()
            .ok_or_else(|| invalid("Saved capture is absent"))?;
        if reference.document_id != capture.summary.document.document_id {
            return Err(ApplicationError::Conflict);
        }
        // The document may have changed again between synchronization and this acknowledgement.
        // Preserve successful saving, but never bind that newer content to the original command.
        let document = match self.find_document(scope, &window.window.window_id, reference) {
            Ok(document) => Some(document),
            Err(ApplicationError::NotFound | ApplicationError::Conflict) => None,
            Err(error) => return Err(error),
        };
        let applied = document
            .filter(|d| {
                d.text == capture.text
                    && d.base_text.as_deref() == Some(capture.text.as_str())
                    && d.base_hash.as_ref() == Some(&capture.summary.sha256)
                    && d.path == capture.summary.path
                    && d.selection == capture.summary.selection
                    && d.readonly_reason.is_none()
            })
            .map(|d| document_summary(&d));
        command.receipt.applied_documents = Some(applied.iter().map(|d|d.document.clone()).collect());
        command.receipt.applied_document_summaries=Some(applied.into_iter().collect());
        command.receipt.save_synchronized = Some(true);
        let receipt = command.receipt.clone();
        self.commit(
            scope,
            window,
            ApplicationStoreChanges {
                commands: vec![command],
                ..Default::default()
            },
        )?;
        Ok(receipt)
    }

    /// Private Host reconciliation input, never returned through an Agent query.
    /// It includes only steps already submitted, so status reads cannot run work.
    pub fn status_executions(
        &self,
        context: &CallContext,
        args: &ApplicationCommandStatusArguments,
    ) -> Result<Vec<(ApplicationExecuteRequest, ApplicationOperationLookup)>, ApplicationError>
    {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let command = self
            .store
            .command(&scope, &args.window.window_id, &args.request_id)?
            .ok_or(ApplicationError::NotFound)?;
        if command.request.window != args.window {
            return Err(ApplicationError::IncarnationChanged);
        }
        let Some(execution_ref) = command.execution_ref.as_ref() else {
            return Ok(vec![]);
        };
        let mut result = vec![];
        for step in [
            ApplicationExecutionStep::Save,
            ApplicationExecutionStep::Run,
        ] {
            let receipt = match step {
                ApplicationExecutionStep::Save => command.receipt.save.as_ref(),
                ApplicationExecutionStep::Run => command.receipt.run.as_ref(),
            };
            let has_invocation = match step {
                ApplicationExecutionStep::Save => command.save_invocation.is_some(),
                ApplicationExecutionStep::Run => command.run_invocation.is_some(),
            };
            if has_invocation
                && receipt.is_some_and(|r| r.state != ApplicationStepState::NotSubmitted)
            {
                result.push((
                    ApplicationExecuteRequest {
                        session: ApplicationBridgeSession {
                            window: args.window.clone(),
                            bridge_token: String::new(),
                        },
                        request_id: args.request_id.clone(),
                        execution_ref: execution_ref.clone(),
                        step,
                    },
                    lookup(&command, step)?,
                ));
            }
        }
        Ok(result)
    }
    pub(crate) fn capture(
        &self,
        scope: &ApplicationScope,
        window: &StoredWindow,
        action: &ApplicationAction,
    ) -> Result<Option<StoredCapture>, ApplicationError> {
        let (reference, target, run) = match action {
            ApplicationAction::Save {
                document,
                target_path,
            } => (document, target_path, false),
            ApplicationAction::RunFile {
                document,
                target_path,
            } => (document, target_path, true),
            ApplicationAction::RunSelection { document } => (document, &None, true),
            _ => return Ok(None),
        };
        let document = self.find_document(scope, &window.window.window_id, reference)?;
        let path = target.as_ref().or(document.path.as_ref()).cloned();
        let run_code = if run {
            let code = if matches!(action, ApplicationAction::RunSelection { .. }) {
                let text = editor_text(&document.text);
                let a = utf16_offset(&text, document.selection.anchor)?;
                let b = utf16_offset(&text, document.selection.head)?;
                if a == b {
                    let from = text[..a].rfind('\n').map_or(0, |i| i + 1);
                    let to = text[a..].find('\n').map_or(text.len(), |i| a + i);
                    text[from..to].to_owned()
                } else {
                    text[a.min(b)..a.max(b)].to_owned()
                }
            } else {
                document.text.clone()
            };
            if code.trim().is_empty() {
                return Err(invalid("captured code is empty"));
            }
            Some(code)
        } else {
            None
        };
        Ok(Some(StoredCapture {
            summary: ApplicationCaptureSummary {
                document: reference.clone(),
                path,
                base_hash: document.base_hash,
                sha256: sha256(&document.text),
                utf8_bytes: document.text.len(),
                run_sha256: run_code.as_ref().map(sha256),
                native_session_id: window.context.native_session_id.clone(),
                workspace_instance_id: window.context.workspace_instance_id.clone(),
                selection: document.selection,
            },
            text: document.text,
            base_text: document.base_text,
            run_code,
        }))
    }

    /// Atomically marks a fixed step as submitting before Host enters the existing
    /// OperationGateway. Repeated calls only return a record lookup. They cannot
    /// recreate or replay an invocation, including after an acknowledgement loss.
    pub fn begin_execution(
        &self,
        context: &CallContext,
        request: &ApplicationExecuteRequest,
        now: u64,
    ) -> Result<ApplicationExecutionAdmission, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let mut command = self.load_execution(&scope, request)?;
        let previous_step = step_receipt(&command.receipt, request.step)?;
        if command.cancel_requested
            && matches!(
                previous_step.state,
                ApplicationStepState::NotSubmitted | ApplicationStepState::Cancelled
            )
        {
            return Err(ApplicationError::Conflict);
        }
        let verify_empty = request.step == ApplicationExecutionStep::Save
            && command.capture.as_ref().is_some_and(|capture| {
                capture.text.is_empty() && capture.base_text.as_deref() == Some("")
            });
        if verify_empty
            && previous_step.state == ApplicationStepState::Submitting
            && command.save_invocation.is_none()
        {
            let capture = command.capture.as_ref().unwrap();
            return Ok(ApplicationExecutionAdmission::VerifySaved {
                context: command.context.clone(),
                path: capture
                    .summary
                    .path
                    .clone()
                    .ok_or_else(|| invalid("save target is absent"))?,
                sha256: capture.summary.sha256.clone(),
            });
        }
        if previous_step.state != ApplicationStepState::NotSubmitted {
            return Ok(ApplicationExecutionAdmission::Observe {
                lookup: lookup(&command, request.step)?,
            });
        }
        // Observing an earlier submission is permitted offline; starting any step
        // requires the same live bridge and an explicit request from that bridge.
        let (_, mut window) = self.bridge_window(context, &request.session, now)?;
        if command.receipt.state != ApplicationCommandState::AwaitingExecution {
            return Err(ApplicationError::Conflict);
        }
        if request.step == ApplicationExecutionStep::Run {
            if command
                .receipt
                .save
                .as_ref()
                .is_some_and(|s| s.state != ApplicationStepState::Succeeded)
            {
                return Err(invalid(
                    "run requires the captured Project save to succeed with the exact capture digest",
                ));
            }
            // A managed capture keeps its original instance even if this window
            // selects another one while a save is in flight. The Workspace
            // owner validates the captured native session at execution admission.
            // Older single-session captures still use the bridge's session fence.
            if command
                .capture
                .as_ref()
                .is_some_and(|c| c.summary.workspace_instance_id.is_none())
                && window.context.native_session_id
                    != command
                        .capture
                        .as_ref()
                        .and_then(|c| c.summary.native_session_id.clone())
            {
                return Err(ApplicationError::Conflict);
            }
        }
        if verify_empty {
            let capture = command.capture.as_ref().unwrap();
            let result = ApplicationExecutionAdmission::VerifySaved {
                context: command.context.clone(),
                path: capture
                    .summary
                    .path
                    .clone()
                    .ok_or_else(|| invalid("save target is absent"))?,
                sha256: capture.summary.sha256.clone(),
            };
            step_receipt_mut(&mut command.receipt, request.step)?.state =
                ApplicationStepState::Submitting;
            self.commit(
                &scope,
                &mut window,
                ApplicationStoreChanges {
                    commands: vec![command],
                    ..Default::default()
                },
            )?;
            return Ok(result);
        }
        let invocation = match build_invocation(&command, request.step).and_then(|invocation| {
            invocation.validate().map_err(|e| invalid(e.to_string()))?;
            Ok(invocation)
        }) {
            Ok(invocation) => invocation,
            Err(error) => {
                let receipt = step_receipt_mut(&mut command.receipt, request.step)?;
                receipt.state = ApplicationStepState::Failed;
                receipt.error = Some(error.to_string());
                command.receipt.state = ApplicationCommandState::Failed;
                command.receipt.diagnostic = Some(format!(
                    "The captured request could not be admitted: {error}. No scientific operation was submitted for this step."
                ));
                command.receipt.completed_at_ms = Some(now);
                self.commit(
                    &scope,
                    &mut window,
                    ApplicationStoreChanges {
                        commands: vec![command],
                        ..Default::default()
                    },
                )?;
                return Err(error);
            }
        };
        let receipt = step_receipt_mut(&mut command.receipt, request.step)?;
        receipt.state = ApplicationStepState::Submitting;
        match request.step {
            ApplicationExecutionStep::Save => command.save_invocation = Some(invocation.clone()),
            ApplicationExecutionStep::Run => command.run_invocation = Some(invocation.clone()),
        }
        let original = command.context.clone();
        self.commit(
            &scope,
            &mut window,
            ApplicationStoreChanges {
                commands: vec![command],
                ..Default::default()
            },
        )?;
        Ok(ApplicationExecutionAdmission::Invoke {
            context: original,
            invocation,
        })
    }

    /// The Host records authoritative gateway observations, even if the window
    /// disconnected or acquired a new incarnation after scientific acceptance.
    pub fn record_execution(
        &self,
        context: &CallContext,
        request: &ApplicationExecuteRequest,
        record: &OperationRecord,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let mut command = self.load_execution(&scope, request)?;
        let invocation = match request.step {
            ApplicationExecutionStep::Save => command.save_invocation.as_ref(),
            ApplicationExecutionStep::Run => command.run_invocation.as_ref(),
        }
        .ok_or_else(|| invalid("scientific step has not been submitted"))?;
        validate_record(&self.project, &command, invocation, record)?;
        let previous = step_receipt(&command.receipt, request.step)?;
        if previous
            .operation_id
            .as_ref()
            .is_some_and(|id| id != &record.operation.operation_id)
        {
            return Err(ApplicationError::RequestConflict);
        }
        if matches!(
            previous.state,
            ApplicationStepState::Succeeded
                | ApplicationStepState::Failed
                | ApplicationStepState::Cancelled
        ) || (previous.state == ApplicationStepState::Uncertain
            && previous.operation_id.is_some())
        {
            return Ok(command.receipt);
        }
        let mut state = match record.status {
            OperationStatus::Accepted => ApplicationStepState::Accepted,
            OperationStatus::Running | OperationStatus::Reconciling => {
                ApplicationStepState::Running
            }
            OperationStatus::Succeeded => ApplicationStepState::Succeeded,
            OperationStatus::Failed => ApplicationStepState::Failed,
            OperationStatus::Cancelled => ApplicationStepState::Cancelled,
            OperationStatus::Uncertain => ApplicationStepState::Uncertain,
        };
        let mut error = record.error.clone();
        if request.step == ApplicationExecutionStep::Save
            && record.status == OperationStatus::Succeeded
        {
            let capture = command
                .capture
                .as_ref()
                .ok_or_else(|| invalid("capture is absent"))?;
            let result: ProjectPatchResult =
                serde_json::from_value(record.output.clone().unwrap_or_default())
                    .map_err(|_| invalid("Project save result is not ProjectPatchResult"))?;
            let actual = result.after.files.iter().find(|file| {
                file.path.as_str() == capture.summary.path.as_deref().unwrap_or_default()
            });
            if actual.and_then(|f| f.sha256.as_ref()) != Some(&capture.summary.sha256) {
                state = ApplicationStepState::Uncertain;
                error = Some("Project reported success, but the actual saved digest differs from the fixed capture. Run was not submitted; inspect the Project operation and file.".into());
            }
        }
        let step = step_receipt_mut(&mut command.receipt, request.step)?;
        step.state = state;
        step.operation_id = Some(record.operation.operation_id.clone());
        step.error = error.clone();
        command.receipt.state = match state {
            ApplicationStepState::Failed | ApplicationStepState::Cancelled => {
                ApplicationCommandState::Failed
            }
            ApplicationStepState::Uncertain => ApplicationCommandState::Uncertain,
            ApplicationStepState::Succeeded
                if request.step == ApplicationExecutionStep::Run
                    || command.receipt.run.is_none() =>
            {
                ApplicationCommandState::Applied
            }
            _ => ApplicationCommandState::AwaitingExecution,
        };
        command.receipt.diagnostic = error;
        if command.cancel_requested {
            for step in [&mut command.receipt.save, &mut command.receipt.run]
                .into_iter()
                .flatten()
            {
                if step.state == ApplicationStepState::NotSubmitted {
                    step.state = ApplicationStepState::Cancelled;
                }
            }
            if ![command.receipt.save.as_ref(), command.receipt.run.as_ref()]
                .into_iter()
                .flatten()
                .any(|step| {
                    matches!(
                        step.state,
                        ApplicationStepState::Submitting
                            | ApplicationStepState::Accepted
                            | ApplicationStepState::Running
                    )
                })
            {
                command.receipt.state = ApplicationCommandState::Cancelled;
            }
        }
        command.receipt.completed_at_ms = completion_time(command.receipt.state, now);
        let receipt = command.receipt.clone();
        let mut window = self
            .store
            .window(&scope, &request.session.window.window_id)?
            .ok_or(ApplicationError::NotFound)?;
        self.commit(
            &scope,
            &mut window,
            ApplicationStoreChanges {
                commands: vec![command],
                ..Default::default()
            },
        )?;
        Ok(receipt)
    }

    /// The association is retained after admission/transport failure. Lookup by its
    /// original request ID is the only recovery action; no automatic resubmission.
    pub fn record_execution_error(
        &self,
        context: &CallContext,
        request: &ApplicationExecuteRequest,
        diagnostic: String,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let mut command = self.load_execution(&scope, request)?;
        let step = step_receipt_mut(&mut command.receipt, request.step)?;
        if step.state == ApplicationStepState::Submitting {
            step.state = ApplicationStepState::Uncertain;
            step.error = Some(diagnostic.chars().take(4096).collect());
            command.receipt.state = ApplicationCommandState::Uncertain;
            command.receipt.diagnostic = Some("Scientific admission/result is unconfirmed. Look up the original client_request_id and operation; do not replay the command.".into());
            command.receipt.completed_at_ms = Some(now);
            let mut window = self
                .store
                .window(&scope, &request.session.window.window_id)?
                .ok_or(ApplicationError::NotFound)?;
            self.commit(
                &scope,
                &mut window,
                ApplicationStoreChanges {
                    commands: vec![command.clone()],
                    ..Default::default()
                },
            )?;
        }
        Ok(command.receipt)
    }
    pub fn execution_lookup(
        &self,
        context: &CallContext,
        request: &ApplicationExecuteRequest,
    ) -> Result<ApplicationOperationLookup, ApplicationError> {
        let _lock = self.lock()?;
        let command = self.load_execution(&self.scope(context)?, request)?;
        lookup(&command, request.step)
    }
    /// Records a Project owner's read-only verification of an unchanged empty
    /// file. It records the actual source, observation time and digest, with no
    /// OperationId because no scientific action was submitted.
    pub fn record_saved_verification(
        &self,
        context: &CallContext,
        request: &ApplicationExecuteRequest,
        verification: &ApplicationSaveVerification,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        self.finish_saved_verification(context, request, Ok(verification), now)
    }
    pub fn record_saved_verification_failure(
        &self,
        context: &CallContext,
        request: &ApplicationExecuteRequest,
        diagnostic: &str,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        self.finish_saved_verification(context, request, Err(diagnostic), now)
    }
    fn finish_saved_verification(
        &self,
        context: &CallContext,
        request: &ApplicationExecuteRequest,
        verification: Result<&ApplicationSaveVerification, &str>,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let mut command = self.load_execution(&scope, request)?;
        let capture = command
            .capture
            .as_ref()
            .ok_or_else(|| invalid("capture is absent"))?;
        if request.step != ApplicationExecutionStep::Save
            || !capture.text.is_empty()
            || capture.base_text.as_deref() != Some("")
            || command.save_invocation.is_some()
        {
            return Err(invalid(
                "this association does not represent an unchanged empty-file verification",
            ));
        }
        let step = step_receipt_mut(&mut command.receipt, request.step)?;
        if step.state == ApplicationStepState::Succeeded
            || step.state == ApplicationStepState::Failed
        {
            return Ok(command.receipt);
        }
        if step.state != ApplicationStepState::Submitting {
            return Err(ApplicationError::Conflict);
        }
        match verification {
            Ok(verified) => {
                if capture.summary.path.as_ref() != Some(&verified.path)
                    || capture.summary.sha256 != verified.sha256
                    || verified.source.is_empty()
                    || verified.source.len() > 512
                    || verified.observed_at_ms > now
                {
                    return Err(ApplicationError::Conflict);
                }
                step.state = ApplicationStepState::Succeeded;
                step.verification = Some(verified.clone());
                command.receipt.state = if command.receipt.run.is_some() {
                    ApplicationCommandState::AwaitingExecution
                } else {
                    ApplicationCommandState::Applied
                };
                command.receipt.diagnostic = Some("The Project owner verified the already-identical empty file. No scientific mutation was submitted.".into());
            }
            Err(diagnostic) => {
                step.state = ApplicationStepState::Failed;
                step.error = Some(diagnostic.chars().take(4096).collect());
                command.receipt.state = ApplicationCommandState::Failed;
                command.receipt.diagnostic = Some("The Project owner could not verify the unchanged file. No scientific mutation or subsequent run was submitted.".into());
            }
        }
        if command.cancel_requested {
            command.receipt.state = ApplicationCommandState::Cancelled;
        }
        command.receipt.completed_at_ms = completion_time(command.receipt.state, now);
        let receipt = command.receipt.clone();
        let mut window = self
            .store
            .window(&scope, &request.session.window.window_id)?
            .ok_or(ApplicationError::NotFound)?;
        self.commit(
            &scope,
            &mut window,
            ApplicationStoreChanges {
                commands: vec![command],
                ..Default::default()
            },
        )?;
        Ok(receipt)
    }
    fn load_execution(
        &self,
        scope: &ApplicationScope,
        request: &ApplicationExecuteRequest,
    ) -> Result<StoredCommand, ApplicationError> {
        let command = self
            .store
            .command(
                scope,
                &request.session.window.window_id,
                &request.request_id,
            )?
            .ok_or(ApplicationError::NotFound)?;
        if command.request.window != request.session.window
            || command.execution_ref.as_ref() != Some(&request.execution_ref)
        {
            return Err(ApplicationError::InvalidBridge);
        }
        Ok(command)
    }
}
fn step_receipt(
    receipt: &ApplicationCommandReceipt,
    step: ApplicationExecutionStep,
) -> Result<&ApplicationStepReceipt, ApplicationError> {
    match step {
        ApplicationExecutionStep::Save => receipt.save.as_ref(),
        ApplicationExecutionStep::Run => receipt.run.as_ref(),
    }
    .ok_or_else(|| invalid("step is not part of this application command"))
}
fn step_receipt_mut(
    receipt: &mut ApplicationCommandReceipt,
    step: ApplicationExecutionStep,
) -> Result<&mut ApplicationStepReceipt, ApplicationError> {
    match step {
        ApplicationExecutionStep::Save => receipt.save.as_mut(),
        ApplicationExecutionStep::Run => receipt.run.as_mut(),
    }
    .ok_or_else(|| invalid("step is not part of this application command"))
}
fn lookup(
    command: &StoredCommand,
    step: ApplicationExecutionStep,
) -> Result<ApplicationOperationLookup, ApplicationError> {
    let receipt = step_receipt(&command.receipt, step)?;
    Ok(ApplicationOperationLookup {
        context: command.context.clone(),
        client_request_id: receipt.client_request_id.clone(),
        operation_id: receipt.operation_id.clone(),
    })
}
fn build_invocation(
    command: &StoredCommand,
    step: ApplicationExecutionStep,
) -> Result<Invocation, ApplicationError> {
    let capture = command
        .capture
        .as_ref()
        .ok_or_else(|| invalid("this command has no scientific capture"))?;
    let receipt = step_receipt(&command.receipt, step)?;
    let (capability, arguments, preconditions) = match step {
        ApplicationExecutionStep::Save => {
            let path = capture
                .summary
                .path
                .as_ref()
                .ok_or_else(|| invalid("save target is absent"))?;
            (
                "project.apply_patch",
                json!({"patch": text_patch(path, capture.base_text.as_deref(), &capture.text)?}),
                vec![Precondition {
                    kind: "file.sha256".into(),
                    subject: path.clone(),
                    expected: json!(capture.summary.base_hash),
                }],
            )
        }
        ApplicationExecutionStep::Run => {
            let session = capture
                .summary
                .native_session_id
                .as_ref()
                .ok_or_else(|| invalid("capture has no native session"))?;
            let code = capture
                .run_code
                .as_ref()
                .ok_or_else(|| invalid("capture has no runnable code"))?;
            let kind = if matches!(command.request.action, ApplicationAction::RunFile { .. }) {
                "file"
            } else if capture.summary.selection.anchor == capture.summary.selection.head {
                "line"
            } else {
                "selection"
            };
            let mut arguments = json!({"code": code, "source": {"view_id": capture.summary.document.document_id, "label": capture.summary.path.as_deref().unwrap_or("Untitled.R"), "kind": kind}});
            if let Some(instance) = &capture.summary.workspace_instance_id {
                arguments["workspace_instance_id"] = json!(instance);
            }
            (
                "workspace.run_r",
                arguments,
                vec![Precondition {
                    kind: "workspace.session".into(),
                    subject: "active".into(),
                    expected: json!(session),
                }],
            )
        }
    };
    Ok(Invocation {
        client_request_id: receipt.client_request_id.clone(),
        capability: CapabilityRef {
            id: capability.into(),
            version: 1,
        },
        arguments,
        preconditions,
    })
}
fn validate_record(
    project: &str,
    command: &StoredCommand,
    invocation: &Invocation,
    record: &OperationRecord,
) -> Result<(), ApplicationError> {
    let operation = &record.operation;
    if operation.caller != command.context.caller
        || operation.principal() != command.context.principal()
        || operation.client_request_id != invocation.client_request_id
        || operation.capability != invocation.capability
        || operation.preconditions != invocation.preconditions
    {
        return Err(ApplicationError::RequestConflict);
    }
    let expected_target = if invocation.capability.id == "project.apply_patch" {
        Some(project)
    } else {
        command
            .capture
            .as_ref()
            .and_then(|c| c.summary.native_session_id.as_deref())
    };
    if Some(operation.target.identity.as_str()) != expected_target {
        return Err(ApplicationError::Conflict);
    }
    for (key, value) in invocation
        .arguments
        .as_object()
        .ok_or_else(|| invalid("invocation arguments are not an object"))?
    {
        if operation.normalized_arguments.get(key) != Some(value) {
            return Err(ApplicationError::RequestConflict);
        }
    }
    Ok(())
}

/// A single bounded text hunk preserves bytes and handles missing final newlines.
/// Prefix/suffix matching keeps ordinary edits in large documents small.
fn text_patch(path: &str, before: Option<&str>, after: &str) -> Result<String, ApplicationError> {
    validate_path(path)?;
    let quote = |prefix: &str| format!("\"{prefix}/{}\"", path.replace('"', "\\\""));
    let a = quote("a");
    let b = quote("b");
    let mut patch = format!(
        "diff --git {a} {b}\n{}--- {}\n+++ {b}\n",
        if before.is_none() {
            "new file mode 100644\n"
        } else {
            ""
        },
        if before.is_none() { "/dev/null" } else { &a }
    );
    let old: Vec<&str> = before.unwrap_or_default().split_inclusive('\n').collect();
    let new: Vec<&str> = after.split_inclusive('\n').collect();
    if old.is_empty() && new.is_empty() {
        if before.is_none() {
            return Ok(format!(
                "diff --git {a} {b}\nnew file mode 100644\nindex 0000000..e69de29\n"
            ));
        }
        return Err(invalid(
            "the captured file is already empty; use project.read_text to verify its unchanged digest",
        ));
    }
    let mut prefix = old
        .iter()
        .zip(new.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    // An unchanged nonempty capture still uses the existing verified Project
    // action. Replace one identical line with real surrounding context.
    if prefix == old.len() && prefix == new.len() {
        prefix = 0;
        suffix = old.len().saturating_sub(1);
    }
    let start = prefix.saturating_sub(3);
    let end_old = (old.len() - suffix + 3).min(old.len());
    let end_new = (new.len() - suffix + 3).min(new.len());
    let old_len = end_old - start;
    let new_len = end_new - start;
    patch.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        if old_len == 0 { 0 } else { start + 1 },
        old_len,
        if new_len == 0 { 0 } else { start + 1 },
        new_len
    ));
    let add = |patch: &mut String, prefix: char, line: &str| {
        patch.push(prefix);
        patch.push_str(line);
        if !line.ends_with('\n') {
            patch.push_str("\n\\ No newline at end of file\n");
        }
    };
    // Git requires actual context around a partial hunk. Replacing every line
    // in the hunk, including unchanged context, makes an interior edit look like
    // a zero-context patch and fail even when the file's digest is unchanged.
    for line in &old[start..prefix] {
        add(&mut patch, ' ', line);
    }
    for line in &old[prefix..old.len() - suffix] {
        add(&mut patch, '-', line);
    }
    for line in &new[prefix..new.len() - suffix] {
        add(&mut patch, '+', line);
    }
    for line in &old[old.len() - suffix..end_old] {
        add(&mut patch, ' ', line);
    }
    if patch.len() > 200 * 1024 {
        return Err(ApplicationError::Budget(
            "captured save patch exceeds the existing Project 200 KiB limit; narrow the edit"
                .into(),
        ));
    }
    Ok(patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_partial_saves_apply_with_git_and_preserve_exact_bytes() {
        use std::{
            fs,
            io::Write,
            process::{Command, Stdio},
        };
        let baseline = "# ggtree 简单示意树\nlibrary(ggtree)\nlibrary(ape)\n\nset.seed(2026)\ntr <- 1\np <- 2\nprint(p)\n# retained\n";
        let long = (0..100)
            .map(|n| format!("x{n} <- {n}\r\n"))
            .collect::<String>();
        let cases = vec![
            (
                baseline.to_owned(),
                baseline.replace("library(ape)\n", "library(ape)\nlibrary(ggplot2)\n"),
            ),
            (long.clone(), long.replace("x50 <- 50", "x50 <- 7")),
            (baseline.to_owned(), baseline.replace("p <- 2\n", "")),
            (
                "\u{feff}甲\r\n乙\r\n丙".into(),
                "\u{feff}甲\r\n新\r\n丙".into(),
            ),
            (baseline.to_owned(), baseline.to_owned()),
            ("last".into(), "last\nmore".into()),
        ];
        for (before, after) in cases {
            let dir = tempfile::tempdir().unwrap();
            let path = "分析.R";
            fs::write(dir.path().join(path), &before).unwrap();
            let patch = text_patch(path, Some(&before), &after).unwrap();
            let mut git = Command::new("git")
                .args(["apply", "-"])
                .current_dir(dir.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            git.stdin
                .take()
                .unwrap()
                .write_all(patch.as_bytes())
                .unwrap();
            let output = git.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{patch}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(fs::read(dir.path().join(path)).unwrap(), after.as_bytes());
        }
    }
    #[test]
    fn patch_is_small_for_a_late_edit_and_preserves_no_final_newline() {
        let before = (0..10_000)
            .map(|n| format!("x{n} <- {n}\r\n"))
            .collect::<String>();
        let after = before.replace("x9000 <- 9000", "x9000 <- 7");
        assert!(text_patch("R/分析.R", Some(&before), &after).unwrap().len() < 512);
        assert!(
            text_patch("x.R", Some("a"), "b")
                .unwrap()
                .contains("\\ No newline at end of file")
        );
    }
}
