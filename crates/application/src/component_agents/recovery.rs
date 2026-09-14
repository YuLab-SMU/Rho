//! Application recovery records never dispatch a model or scientific operation.
use super::*;

fn interrupted(run: &mut StoredComponentRun, now: u64) -> ComponentAgentEvent {
    run.run.state = ComponentAgentRunState::Interrupted;
    run.run.reason = Some("The owning Host or model task ended without a final acknowledgement; inspect original tool records before continuing".into());
    run.run.updated_at_ms = now;
    run.run.event_cursor += 1;
    ComponentAgentEvent {
        run_id: run.run.run_id.clone(),
        sequence: run.run.event_cursor,
        created_at_ms: now,
        content: ComponentAgentEventContent::State {
            state: run.run.state,
            reason: run.run.reason.clone(),
        },
    }
}
impl ComponentAgentOwner {
    /// Read-only projection. No old inference/tool loop is revived by observation.
    pub fn observed_run(&self, mut run: StoredComponentRun) -> ComponentAgentRun {
        if run.host_incarnation != self.host_incarnation && !run.run.state.is_terminal() {
            run.run.state = ComponentAgentRunState::Interrupted;
            run.run.reason = Some("The previous Host no longer owns this request; reconcile its original tool records".into());
        }
        run.run
    }

    /// Host must hold its service gate and first verify that this run has no live task.
    pub fn interrupt_abandoned(
        &self,
        scope: &ApplicationScope,
        id: &str,
        now: u64,
    ) -> Result<StoredComponentRun, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let mut run = self
            .store
            .component_run(scope, id)?
            .ok_or(ApplicationError::NotFound)?;
        if run.run.state.is_terminal() {
            return Ok(run);
        }
        let mut conversation = self
            .store
            .component_conversation(scope, &run.run.request.conversation_id)?
            .ok_or(ApplicationError::NotFound)?;
        let event = interrupted(&mut run, now);
        if conversation.active_run_id.as_deref() == Some(id) {
            conversation.active_run_id = None;
        }
        self.save(scope, conversation, Some(&run), &[], &[event], now)?;
        Ok(run)
    }

    /// Explicit CAS takeover preserves drafts and original run/window identities.
    /// Host first fences any live task; a pending orphan is interrupted in this transaction.
    pub fn take_control(
        &self,
        actor: &ComponentActor,
        id: &str,
        expected_version: u64,
        now: u64,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        let mut conversation = self
            .store
            .component_conversation(&actor.scope, id)?
            .ok_or(ApplicationError::NotFound)?;
        if conversation.version != expected_version {
            return Err(ApplicationError::Conflict);
        }
        let mut run = conversation
            .active_run_id
            .as_ref()
            .map(|id| self.store.component_run(&actor.scope, id))
            .transpose()?
            .flatten();
        let events = run
            .as_mut()
            .filter(|r| !r.run.state.is_terminal())
            .map(|r| interrupted(r, now))
            .into_iter()
            .collect::<Vec<_>>();
        conversation.controller = actor.window.clone();
        conversation.active_run_id = None;
        self.save(&actor.scope, conversation, run.as_ref(), &[], &events, now)?;
        self.store
            .component_conversation(&actor.scope, id)?
            .ok_or(ApplicationError::NotFound)
    }

    pub fn record_recovery(
        &self,
        scope: &ApplicationScope,
        id: &str,
        tools: Vec<ComponentRecoveredTool>,
        now: u64,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let mut run = self
            .store
            .component_run(scope, id)?
            .ok_or(ApplicationError::NotFound)?;
        if !run.run.state.is_terminal() {
            return Err(ApplicationError::Conflict);
        }
        let original = self.store.component_tools(scope, id)?;
        if tools.len() != original.len()
            || tools
                .iter()
                .enumerate()
                .any(|(index, t)| tools[..index].iter().any(|p| p.receipt_id == t.receipt_id))
        {
            return Err(ApplicationError::Conflict);
        }
        let mut unresolved = 0;
        for tool in &tools {
            let old = original
                .iter()
                .find(|o| o.receipt.receipt_id == tool.receipt_id)
                .ok_or(ApplicationError::NotFound)?;
            if tool.operations.len() > 2
                || tool.documents.len() > 16
                || tool.note.as_ref().is_some_and(|n| n.len() > 512)
            {
                return Err(invalid("Oversized recovery observation"));
            }
            if old.receipt.mutation
                && matches!(
                    tool.state,
                    ComponentRecoveryState::Pending | ComponentRecoveryState::Uncertain
                )
            {
                unresolved += 1;
            }
        }
        let digest = component_digest(&tools)?;
        if run
            .run
            .recovery
            .as_ref()
            .is_some_and(|old| old.digest == digest)
        {
            return Ok(run.run);
        }
        let version = run.run.recovery.as_ref().map_or(Ok(1), |r| {
            r.version
                .checked_add(1)
                .ok_or_else(|| invalid("Recovery version exhausted"))
        })?;
        run.run.recovery = Some(ComponentAgentRecovery {
            version,
            digest,
            checked_at_ms: now,
            unresolved_mutations: unresolved,
            tools,
        });
        let mut recovered_grants = Vec::new();
        for entry in &run.run.recovery.as_ref().unwrap().tools {
            if entry.state != ComponentRecoveryState::Confirmed || entry.application_state != Some(ApplicationCommandState::Applied) {continue;}
            let action = original.iter().find(|tool| tool.receipt.receipt_id == entry.receipt_id)
                .map(|tool| &tool.action).ok_or(ApplicationError::NotFound)?;
            let path = match action {
                ComponentToolAction::Control(command) => match &command.action {
                    ApplicationAction::OpenDocument {path,..} | ApplicationAction::CreateDocument {path:Some(path),..} => path,
                    _ => continue,
                }, _ => continue,
            };
            if entry.documents.len() != 1 { return Err(invalid("A recovered document requires one exact owner reference")); }
            let document = self.confirmed_document(scope, &run.run, &entry.documents[0])?;
            recovered_grants.push(ComponentDocumentGrant {document, path:Some(path.clone()), allow_save:false});
        }
        for grant in recovered_grants {
            if let Some(existing) = run.run.document_grants.iter_mut()
                .find(|existing| existing.document.document_id == grant.document.document_id) {
                if existing.path != grant.path {return Err(invalid("Recovered document path differs from the original target"));}
                existing.document = grant.document.clone();
            } else {
                if run.run.document_grants.len() + run.run.request.grant.documents.len() >= 16 {
                    return Err(ApplicationError::Budget("Task document target limit reached".into()));
                }
                run.run.document_grants.push(grant.clone());
            }
            run.run.document_versions.get_or_insert_with(Default::default)
                .insert(grant.document.document_id.clone(), grant.document);
        }
        run.run.updated_at_ms = now;
        run.run.event_cursor += 1;
        let event = ComponentAgentEvent {
            run_id: id.into(),
            sequence: run.run.event_cursor,
            created_at_ms: now,
            content: ComponentAgentEventContent::Recovery { version },
        };
        let conversation = self
            .store
            .component_conversation(scope, &run.run.request.conversation_id)?
            .ok_or(ApplicationError::NotFound)?;
        self.save(scope, conversation, Some(&run), &[], &[event], now)?;
        Ok(run.run)
    }
}
