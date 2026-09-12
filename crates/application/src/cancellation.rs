//! Cancellation of an already-admitted application command, never rollback.
use super::*;
impl ApplicationOwner {
    pub fn cancel_command(
        &self,
        context: &CallContext,
        reference: &ApplicationWindowRef,
        request_id: &str,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let _guard = self.lock()?;
        let scope = self.scope(context)?;
        let mut command = self
            .store
            .command(&scope, &reference.window_id, request_id)?
            .ok_or(ApplicationError::NotFound)?;
        if command.request.window != *reference || command.context.caller != context.caller {
            return Err(ApplicationError::Conflict);
        }
        if matches!(
            command.receipt.state,
            ApplicationCommandState::Applied
                | ApplicationCommandState::Failed
                | ApplicationCommandState::Expired
                | ApplicationCommandState::Cancelled
                | ApplicationCommandState::Uncertain
                | ApplicationCommandState::LocallyAppliedUnsynced
        ) {
            return Ok(command.receipt);
        }
        command.cancel_requested = true;
        let in_flight = [command.receipt.save.as_ref(), command.receipt.run.as_ref()]
            .into_iter()
            .flatten()
            .any(|step| {
                matches!(
                    step.state,
                    ApplicationStepState::Submitting
                        | ApplicationStepState::Accepted
                        | ApplicationStepState::Running
                )
            });
        for step in [&mut command.receipt.save, &mut command.receipt.run]
            .into_iter()
            .flatten()
        {
            if step.state == ApplicationStepState::NotSubmitted {
                step.state = ApplicationStepState::Cancelled;
            }
        }
        if command.receipt.state == ApplicationCommandState::Pending
            || (command.receipt.state == ApplicationCommandState::AwaitingExecution && !in_flight)
        {
            command.receipt.state = ApplicationCommandState::Cancelled;
            command.receipt.completed_at_ms = Some(now);
        }
        command.receipt.diagnostic=Some("Cancellation requested; confirmed local changes and accepted scientific operations are not rolled back".into());
        let receipt = command.receipt.clone();
        let mut window = self
            .store
            .window(&scope, &reference.window_id)?
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
}
