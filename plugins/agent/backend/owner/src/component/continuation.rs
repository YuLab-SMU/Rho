//! Continuation authority and action identity remain Agent-owner records.
use super::*;
impl ComponentAgentOwner {
    pub(super) fn validate_native_continuation(
        &self,
        scope: &ApplicationScope,
        request: &ComponentAgentStart,
        origin: &ComponentNativeRunOrigin,
    ) -> Result<(), ApplicationError> {
        let Some(reference) = &request.continuation else {
            return Ok(());
        };
        let previous = self
            .store
            .component_run(scope, &reference.run_id)?
            .ok_or(ApplicationError::NotFound)?;
        let old = previous
            .native_origin
            .ok_or_else(|| invalid("Continue requires an original native model task"))?;
        if old.binding != origin.binding {
            return Err(invalid(
                "Continue cannot replace the original Agent provider",
            ));
        }
        match (&old.r, &origin.r) {
            (_, None) if request.grant.mode == ComponentAgentMode::Explain => Ok(()),
            (Some(old), Some(next)) if old == next => Ok(()),
            (Some(old), Some(next))
                if request.grant.mode == ComponentAgentMode::Explain
                    && old.provider == next.provider
                    && old.project == next.project
                    && old.target == next.target
                    && next.capability.id.as_str() == "r.session"
                    && next.capability.version == 1 =>
            {
                Ok(())
            }
            _ => Err(invalid(
                "Continue cannot replace the original R provider, version or native session",
            )),
        }
    }
    pub fn ancestor_runs(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
    ) -> Result<Vec<StoredComponentRun>, ApplicationError> {
        let mut result = Vec::<StoredComponentRun>::new();
        let mut reference = run.request.continuation.clone();
        while let Some(previous) = reference {
            if result.len() >= 32
                || previous.run_id == run.run_id
                || result.iter().any(|r| r.run.run_id == previous.run_id)
            {
                return Err(invalid(
                    "Continuation history exceeds its limit or contains a cycle",
                ));
            }
            let record = self
                .store
                .component_run(scope, &previous.run_id)?
                .ok_or(ApplicationError::NotFound)?;
            if record.run.request.conversation_id != run.request.conversation_id
                || !record.run.state.is_terminal()
            {
                return Err(ApplicationError::Conflict);
            }
            result.push(record);
            reference = result
                .last()
                .and_then(|r| r.run.request.continuation.clone());
        }
        Ok(result)
    }
    pub(super) fn validate_continuation(
        &self,
        scope: &ApplicationScope,
        request: &ComponentAgentStart,
    ) -> Result<(), ApplicationError> {
        let Some(reference) = &request.continuation else {
            return Ok(());
        };
        let previous = self
            .store
            .component_run(scope, &reference.run_id)?
            .ok_or(ApplicationError::NotFound)?;
        let recovery = previous
            .run
            .recovery
            .as_ref()
            .ok_or_else(|| invalid("Reconcile the previous request before Continue"))?;
        if !previous.run.state.is_terminal()
            || previous.run.request.conversation_id != request.conversation_id
            || recovery.digest != reference.recovery_digest
        {
            return Err(ApplicationError::Conflict);
        }
        if self.ancestor_runs(scope, &previous.run)?.len() >= 32 {
            return Err(invalid(
                "Continuation history limit reached; start a fresh request",
            ));
        }
        let old = &previous.run.request.grant;
        let next = &request.grant;
        if next.permission_policy.is_none() && next.mode == ComponentAgentMode::Explain {
            return Ok(());
        }
        if recovery.unresolved_mutations > 0
            || request.window != previous.run.request.window
            || next.permission_policy != old.permission_policy
            || (next.permission_policy.is_none()
                && (old.mode == ComponentAgentMode::Explain
                    || (next.mode == ComponentAgentMode::Run
                        && old.mode != ComponentAgentMode::Run)))
            || next.session != old.session
        {
            return Err(invalid(
                "Continue cannot expand authority or replace an unresolved target",
            ));
        }
        for doc in &next.documents {
            let allowed = component_document_grant(&previous.run, &doc.document.document_id)
                .ok_or_else(|| invalid("Continue document is outside the original grant"))?;
            if doc.path != allowed.path
                || (doc.allow_save && !allowed.allow_save)
                || doc.document
                    != self.confirmed_document(scope, &previous.run, &allowed.document)?
            {
                return Err(invalid(
                    "Document changed outside confirmed assistant actions; start a fresh request",
                ));
            }
        }
        for file in &next.files {
            if !old.files.contains(file) {
                return Err(invalid("Continue file is outside the original grant"));
            }
        }
        Ok(())
    }
    pub(super) fn continued_authority(
        &self,
        scope: &ApplicationScope,
        request: &ComponentAgentStart,
    ) -> Result<
        (
            Option<ComponentAgentTaskIntent>,
            Vec<ComponentDocumentGrant>,
        ),
        ApplicationError,
    > {
        let Some(reference) = &request.continuation else {
            return Ok((None, vec![]));
        };
        let previous = self
            .store
            .component_run(scope, &reference.run_id)?
            .ok_or(ApplicationError::NotFound)?;
        let mut documents = previous.run.document_grants.clone();
        for grant in &mut documents {
            grant.document = self.confirmed_document(scope, &previous.run, &grant.document)?;
        }
        Ok((previous.run.task_intent.clone(), documents))
    }
    pub fn confirmed_document(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
        initial: &ApplicationDocumentRef,
    ) -> Result<ApplicationDocumentRef, ApplicationError> {
        let tools = self.store.component_tools(scope, &run.run_id)?;
        let mut links = Vec::new();
        if let Some(report) = &run.recovery {
            for entry in report
                .tools
                .iter()
                .filter(|r| r.state == ComponentRecoveryState::Confirmed)
            {
                let tool = tools
                    .iter()
                    .find(|t| t.receipt.receipt_id == entry.receipt_id)
                    .ok_or(ApplicationError::NotFound)?;
                if let ComponentToolAction::Control(command) = &tool.action {
                    let before = match &command.action {
                        ApplicationAction::EditDocument { document, .. }
                        | ApplicationAction::Save { document, .. }
                        | ApplicationAction::RunFile { document, .. } => document,
                        _ => continue,
                    };
                    for after in entry
                        .documents
                        .iter()
                        .filter(|d| d.document_id == before.document_id && *d != before)
                    {
                        links.push((before.clone(), after.clone()));
                    }
                }
            }
        }
        follow(initial, &links)
    }
    pub fn previous_tool(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
        source_run: &str,
        receipt: &str,
    ) -> Result<(StoredComponentRun, StoredComponentTool), ApplicationError> {
        let ancestor = self
            .ancestor_runs(scope, run)?
            .into_iter()
            .find(|r| r.run.run_id == source_run)
            .ok_or(ApplicationError::NotFound)?;
        if !ancestor.run.recovery.as_ref().is_some_and(|r| {
            r.tools
                .iter()
                .any(|t| t.receipt_id == receipt && t.state == ComponentRecoveryState::Confirmed)
        }) {
            return Err(invalid(
                "The previous action has no confirmed recovery observation",
            ));
        }
        let tool = self
            .store
            .component_tools(scope, source_run)?
            .into_iter()
            .find(|t| t.receipt.receipt_id == receipt)
            .ok_or(ApplicationError::NotFound)?;
        Ok((ancestor, tool))
    }
    pub fn owned_operations(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
        current: &[StoredComponentTool],
    ) -> Result<std::collections::BTreeSet<OperationId>, ApplicationError> {
        let mut ids = component_owned_operations(current)?;
        for ancestor in self.ancestor_runs(scope, run)? {
            let recovery = ancestor
                .run
                .recovery
                .ok_or_else(|| invalid("Continuation has no recovery observations"))?;
            for tool in recovery
                .tools
                .iter()
                .filter(|t| t.state == ComponentRecoveryState::Confirmed)
            {
                ids.extend(tool.operations.iter().map(|o| o.operation_id.clone()));
            }
        }
        Ok(ids)
    }
    pub(super) fn prior_saved_identity(
        &self,
        scope: &ApplicationScope,
        reference: &ApplicationDocumentRef,
        ancestors: &[StoredComponentRun],
    ) -> Result<ApplicationDocumentRef, ApplicationError> {
        let mut links = Vec::new();
        for ancestor in ancestors {
            let tools = self.store.component_tools(scope, &ancestor.run.run_id)?;
            if let Some(recovery) = &ancestor.run.recovery {
                for entry in recovery
                    .tools
                    .iter()
                    .filter(|e| e.state == ComponentRecoveryState::Confirmed)
                {
                    let tool = tools
                        .iter()
                        .find(|t| t.receipt.receipt_id == entry.receipt_id)
                        .ok_or(ApplicationError::NotFound)?;
                    if let ComponentToolAction::Control(command) = &tool.action {
                        let before = match &command.action {
                            ApplicationAction::Save { document, .. }
                            | ApplicationAction::RunFile { document, .. } => document,
                            _ => continue,
                        };
                        for after in entry
                            .documents
                            .iter()
                            .filter(|d| d.document_id == before.document_id && *d != before)
                        {
                            links.push((after.clone(), before.clone()));
                        }
                    }
                }
            }
        }
        follow(reference, &links)
    }
}
fn follow(
    initial: &ApplicationDocumentRef,
    links: &[(ApplicationDocumentRef, ApplicationDocumentRef)],
) -> Result<ApplicationDocumentRef, ApplicationError> {
    let mut current = initial.clone();
    for _ in 0..=links.len() {
        let next: Vec<_> = links
            .iter()
            .filter(|(from, _)| from == &current)
            .map(|(_, to)| to)
            .collect();
        let Some(first) = next.first() else {
            return Ok(current);
        };
        if next.iter().any(|other| other != first) {
            return Err(invalid(
                "Document version history has conflicting successors",
            ));
        }
        current = (*first).clone();
    }
    Err(invalid("Document version history contains a cycle"))
}
