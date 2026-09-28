//! Durable admission for optional component assistants. No model or native dispatch.
use super::AgentTaskScope as ApplicationScope;
mod boundary;
use ComponentTaskError as ApplicationError;
pub use boundary::*;
use rho_agent_api::component::*;
use rho_agent_api::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

mod continuation;
mod permissions;
mod policy;
mod recovery;
pub use policy::{
    component_query_allowed, component_query_available, validate_component_grant,
    validate_component_model,
};

pub const MAX_COMPONENT_CONVERSATIONS: usize = 4096;
pub const MAX_COMPONENT_EVENTS: usize = 500;
pub const MAX_COMPONENT_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_COMPONENT_PROJECT_EVENT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_COMPONENT_PROJECT_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_COMPONENT_RUN_RECORD_BYTES: usize = 512 * 1024;
pub const MAX_COMPONENT_TOOL_RECORD_BYTES: usize = 512 * 1024;
pub const MAX_COMPONENT_CONVERSATION_RECORD_BYTES: usize = 64 * 1024;
pub const MAX_COMPONENT_DIAGNOSTIC_RECORD_BYTES: usize = 16 * 1024;
pub const MAX_COMPONENT_SETTINGS_RECORD_BYTES: usize = 8 * 1024;
pub const MAX_COMPONENT_QUEUED_RUNS: usize = 10; // two running plus eight waiting
pub const MAX_COMPONENT_RUNNING_RUNS: usize = 2;
pub const MAX_COMPONENT_TEXT_BYTES: usize = 32 * 1024;

/// Issued by an admitted caller adapter. The validator rechecks the original
/// native controller before caller-controlled writes; this is not a deserializable credential.
pub struct ComponentActor {
    scope: ApplicationScope,
    window: ApplicationWindowRef,
    validator: Arc<dyn ComponentActorValidator>,
}
pub trait ComponentActorValidator: Send + Sync {
    fn validate(&self, now: u64) -> Result<(), ComponentTaskError>;
}
impl ComponentActor {
    pub fn new(
        scope: ApplicationScope,
        window: ApplicationWindowRef,
        validator: Arc<dyn ComponentActorValidator>,
    ) -> Self {
        Self {
            scope,
            window,
            validator,
        }
    }
    pub fn scope(&self) -> &ApplicationScope {
        &self.scope
    }
    pub fn window(&self) -> &ApplicationWindowRef {
        &self.window
    }
    fn validate(&self, now: u64) -> Result<(), ComponentTaskError> {
        self.validator.validate(now)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredComponentRun {
    pub run: ComponentAgentRun,
    pub request_digest: String,
    pub host_incarnation: String,
}

/// Constructed by the trusted tool adapter after binding identities. The owner
/// checks the action again before persisting it. Host still validates native scope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "request", rename_all = "snake_case")]
pub enum ComponentToolAction {
    TaskIntent(ComponentAgentTaskIntent),
    Query(QueryRequest),
    PreviousResult {
        capability: CapabilityRef,
        run_id: String,
        receipt_id: String,
    },
    Invoke(Invocation),
    Control(ApplicationCommandRequest),
    /// A rejected model argument attempt; this variant has no native dispatch.
    Rejected {
        capability: CapabilityRef,
        arguments_digest: String,
        feedback: Value,
    },
}
impl ComponentToolAction {
    pub fn capability(&self) -> &str {
        match self {
            Self::TaskIntent(_) => "agent.task_intent",
            Self::Query(q) => &q.capability.id,
            Self::Invoke(i) => &i.capability.id,
            Self::Control(_) => "application.control",
            Self::Rejected { capability, .. } | Self::PreviousResult { capability, .. } => {
                &capability.id
            }
        }
    }
    pub fn mutation(&self) -> bool {
        matches!(self, Self::Invoke(_) | Self::Control(_))
    }
    pub fn requires_permission(&self) -> bool {
        self.mutation()
            && !matches!(self, Self::Control(command)
            if matches!(command.action, ApplicationAction::OpenDocument { .. }))
    }
    fn bind_request(&mut self, id: &str) {
        match self {
            Self::Invoke(i) => i.client_request_id = id.into(),
            Self::Control(c) => c.request_id = id.into(),
            Self::TaskIntent(_)
            | Self::Query(_)
            | Self::Rejected { .. }
            | Self::PreviousResult { .. } => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredComponentTool {
    pub receipt: ComponentToolReceipt,
    pub action: ComponentToolAction,
    pub calls: Vec<ComponentToolCall>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentToolCall {
    pub model_call: u32,
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ComponentToolOrigin>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentToolOrigin {
    pub name: String,
    pub arguments_digest: String,
}

pub struct ComponentWrite<'a> {
    pub expected_version: Option<u64>,
    pub conversation: &'a ComponentAgentConversation,
    pub run: Option<&'a StoredComponentRun>,
    pub tools: &'a [StoredComponentTool],
    pub events: &'a [ComponentAgentEvent],
}

pub trait ComponentAgentRepository: Send + Sync {
    fn component_assets(
        &self,
        _scope: &ApplicationScope,
        _conversation: &str,
    ) -> Result<Vec<AgentAsset>, ApplicationError> {
        Err(ApplicationError::InvalidInput(
            "Attachments are unavailable in this repository".into(),
        ))
    }
    fn component_asset(
        &self,
        _scope: &ApplicationScope,
        _conversation: &str,
        _asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), ApplicationError> {
        Err(ApplicationError::NotFound)
    }
    fn put_component_asset(
        &self,
        _scope: &ApplicationScope,
        _conversation: &str,
        _asset: &AgentAsset,
        _bytes: &[u8],
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::InvalidInput(
            "Attachments are unavailable in this repository".into(),
        ))
    }

    fn component_diagnostic(
        &self,
        scope: &ApplicationScope,
        request_id: &str,
    ) -> Result<Option<ComponentModelDiagnostic>, ApplicationError>;
    fn component_diagnostics(
        &self,
        scope: &ApplicationScope,
    ) -> Result<Vec<ComponentModelDiagnostic>, ApplicationError>;
    fn write_component_diagnostic(
        &self,
        scope: &ApplicationScope,
        expected: Option<u64>,
        diagnostic: &ComponentModelDiagnostic,
    ) -> Result<(), ApplicationError>;
    fn component_conversation(
        &self,
        scope: &ApplicationScope,
        id: &str,
    ) -> Result<Option<ComponentAgentConversation>, ApplicationError>;
    fn component_conversations(
        &self,
        scope: &ApplicationScope,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ComponentAgentConversation>, ApplicationError>;
    fn component_run(
        &self,
        scope: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError>;
    fn component_run_by_request(
        &self,
        scope: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError>;
    fn component_run_history(
        &self,
        scope: &ApplicationScope,
        conversation: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(ComponentAgentRunSummary, String)>, ApplicationError>;
    fn component_tools(
        &self,
        scope: &ApplicationScope,
        run: &str,
    ) -> Result<Vec<StoredComponentTool>, ApplicationError>;
    fn component_events(
        &self,
        scope: &ApplicationScope,
        run: &str,
        after: u64,
        limit: usize,
    ) -> Result<ComponentAgentEventPage, ApplicationError>;
    fn component_settings(
        &self,
        scope: &ApplicationScope,
    ) -> Result<ComponentModelSettings, ApplicationError>;
    fn write_component_settings(
        &self,
        scope: &ApplicationScope,
        expected: u64,
        settings: &ComponentModelSettings,
    ) -> Result<(), ApplicationError>;
    fn commit_component(
        &self,
        scope: &ApplicationScope,
        write: ComponentWrite<'_>,
    ) -> Result<(), ApplicationError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentRunAdmission {
    pub run: StoredComponentRun,
    pub repeated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentToolAdmission {
    pub tool: StoredComponentTool,
    pub repeated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ComponentToolUpdate {
    Rejected {
        reason: String,
        diagnostic: Diagnostic,
    },
    Accepted {
        operation_id: Option<OperationId>,
        application_request_id: Option<String>,
    },
    Resolved {
        result: Value,
        evidence: Vec<ComponentAgentEvidence>,
    },
    Uncertain {
        reason: String,
    },
}

pub struct ComponentAgentOwner {
    pub store: Arc<dyn ComponentAgentRepository>,
    pub host_incarnation: String,
    gate: Mutex<()>,
}

impl ComponentAgentOwner {
    pub fn with_handoff_write<T, E: From<ApplicationError>>(
        &self,
        write: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| ApplicationError::Storage("Component metadata lock poisoned".into()))?;
        write()
    }
}

pub(crate) fn invalid(message: impl Into<String>) -> ApplicationError {
    ApplicationError::InvalidInput(message.into())
}
pub(crate) fn storage(error: impl ToString) -> ApplicationError {
    ApplicationError::Storage(error.to_string())
}
fn id(value: &str) -> Result<(), ApplicationError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return Err(invalid("Invalid component identity"));
    }
    Ok(())
}
pub fn component_document_reference<'a>(
    run: &'a ComponentAgentRun,
    id: &str,
) -> Option<&'a ApplicationDocumentRef> {
    run.document_versions
        .as_ref()
        .and_then(|versions| versions.get(id))
        .or_else(|| {
            run.document_grants
                .iter()
                .chain(run.request.grant.documents.iter())
                .find(|grant| grant.document.document_id == id)
                .map(|grant| &grant.document)
        })
}

pub fn component_document_grant<'a>(
    run: &'a ComponentAgentRun,
    id: &str,
) -> Option<&'a ComponentDocumentGrant> {
    run.document_grants
        .iter()
        .chain(run.request.grant.documents.iter())
        .find(|grant| grant.document.document_id == id)
}
/// Native identities already linked to this run's durable mutation receipts.
pub fn component_owned_operations(
    tools: &[StoredComponentTool],
) -> Result<std::collections::BTreeSet<OperationId>, ApplicationError> {
    let mut ids = std::collections::BTreeSet::new();
    for tool in tools.iter().filter(|t| t.receipt.mutation) {
        if let Some(id) = &tool.receipt.operation_id {
            ids.insert(id.clone());
        }
        if matches!(tool.action, ComponentToolAction::Control(_))
            && tool.receipt.phase == ComponentToolPhase::Resolved
        {
            let receipt: ApplicationCommandReceipt = serde_json::from_value(
                tool.receipt
                    .result
                    .clone()
                    .ok_or_else(|| storage("Native application result is absent"))?,
            )
            .map_err(storage)?;
            for step in [receipt.save, receipt.run].into_iter().flatten() {
                if let Some(id) = step.operation_id {
                    ids.insert(id);
                }
            }
        }
    }
    Ok(ids)
}

/// Saving advances the editor version without changing captured text/selection.
/// Follow only owner-confirmed save receipts so a repeated save/run keeps its
/// original identity. An actual edit has no save link and starts a new identity.
fn saved_document_identity(
    reference: &ApplicationDocumentRef,
    tools: &[StoredComponentTool],
) -> Result<ApplicationDocumentRef, ApplicationError> {
    let mut links = Vec::new();
    for tool in tools {
        let ComponentToolAction::Control(command) = &tool.action else {
            continue;
        };
        let (ApplicationAction::Save { document, .. }
        | ApplicationAction::RunFile { document, .. }) = &command.action
        else {
            continue;
        };
        if tool.receipt.phase != ComponentToolPhase::Resolved {
            continue;
        }
        let receipt: ApplicationCommandReceipt = serde_json::from_value(
            tool.receipt
                .result
                .clone()
                .ok_or_else(|| storage("Resolved application result is absent"))?,
        )
        .map_err(storage)?;
        if receipt.save_synchronized != Some(true) {
            continue;
        }
        if let Some(updated) = receipt
            .applied_documents
            .as_ref()
            .and_then(|refs| refs.iter().find(|r| r.document_id == document.document_id))
            && updated != document
        {
            links.push((updated.clone(), document.clone()));
        }
    }
    let mut identity = reference.clone();
    for _ in 0..=links.len() {
        let Some((_, earlier)) = links.iter().find(|(updated, _)| updated == &identity) else {
            return Ok(identity);
        };
        identity = earlier.clone();
    }
    Err(storage("Saved document identity contains a cycle"))
}

pub fn component_digest(value: &impl Serialize) -> Result<String, ApplicationError> {
    fn canonical(value: Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(k, v)| (k, canonical(v)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
            other => other,
        }
    }
    let bytes = serde_json::to_vec(&canonical(serde_json::to_value(value).map_err(storage)?))
        .map_err(storage)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn budget() -> ComponentAgentBudget {
    let (model_calls, tool_calls) = (12, 16);
    ComponentAgentBudget {
        model_calls,
        tool_calls,
        context_bytes: 64 * 1024,
        tool_result_bytes: 256 * 1024,
        output_tokens: 2048,
        duration_ms: 600_000,
    }
}

impl ComponentAgentOwner {
    pub fn begin_model_test(
        &self,
        actor: &ComponentActor,
        request: &ComponentModelTestRequest,
        now: u64,
    ) -> Result<(ComponentModelDiagnostic, bool), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        id(&request.request_id)?;
        if request.window != actor.window || request.project_root != actor.scope.project {
            return Err(ApplicationError::Conflict);
        }
        if let Some(previous) = self
            .store
            .component_diagnostic(&actor.scope, &request.request_id)?
        {
            if previous.window != request.window
                || previous.kind != request.kind
                || previous.model_settings_version != request.model_settings_version
            {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok((previous, true));
        }
        let settings = self.store.component_settings(&actor.scope)?;
        if settings.version != request.model_settings_version {
            return Err(ApplicationError::Conflict);
        }
        let model = settings
            .connection
            .ok_or_else(|| invalid("Configure a model before testing"))?;
        validate_component_model(&model)?;
        let diagnostic = ComponentModelDiagnostic {
            request_id: request.request_id.clone(),
            version: 1,
            window: request.window.clone(),
            model_settings_version: settings.version,
            connection_digest: component_digest(&model)?,
            model,
            kind: request.kind,
            state: ComponentModelTestState::Queued,
            created_at_ms: now,
            updated_at_ms: now,
            detail: None,
        };
        self.store
            .write_component_diagnostic(&actor.scope, None, &diagnostic)?;
        Ok((diagnostic, false))
    }
    pub fn update_model_test(
        &self,
        scope: &ApplicationScope,
        request_id: &str,
        state: ComponentModelTestState,
        detail: Option<String>,
        now: u64,
    ) -> Result<ComponentModelDiagnostic, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let mut diagnostic = self
            .store
            .component_diagnostic(scope, request_id)?
            .ok_or(ApplicationError::NotFound)?;
        if !matches!(
            diagnostic.state,
            ComponentModelTestState::Queued | ComponentModelTestState::Running
        ) || detail.as_ref().is_some_and(|v| v.len() > 4096)
        {
            return Err(ApplicationError::Conflict);
        }
        let version = diagnostic.version;
        diagnostic.version += 1;
        diagnostic.state = state;
        diagnostic.detail = detail;
        diagnostic.updated_at_ms = now;
        self.store
            .write_component_diagnostic(scope, Some(version), &diagnostic)?;
        Ok(diagnostic)
    }
    pub fn new(store: Arc<dyn ComponentAgentRepository>, host_incarnation: String) -> Self {
        Self {
            store,
            host_incarnation,
            gate: Mutex::new(()),
        }
    }
    fn conversation(
        &self,
        actor: &ComponentActor,
        id: &str,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        let conversation = self
            .store
            .component_conversation(&actor.scope, id)?
            .ok_or(ApplicationError::NotFound)?;
        if conversation.controller != actor.window {
            return Err(ApplicationError::Conflict);
        }
        Ok(conversation)
    }
    fn active(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        now: u64,
    ) -> Result<(ComponentAgentConversation, StoredComponentRun), ApplicationError> {
        let run = self
            .store
            .component_run(scope, run_id)?
            .ok_or(ApplicationError::NotFound)?;
        let conversation = self
            .store
            .component_conversation(scope, &run.run.request.conversation_id)?
            .ok_or(ApplicationError::NotFound)?;
        if run.host_incarnation != self.host_incarnation
            || conversation.active_run_id.as_deref() != Some(run_id)
            || conversation.controller != run.run.request.window
            || run.run.state.is_terminal()
        {
            return Err(ApplicationError::Conflict);
        }
        if now
            >= run
                .run
                .created_at_ms
                .saturating_add(run.run.budget.duration_ms)
        {
            return Err(ApplicationError::Budget(
                "Component run deadline exceeded".into(),
            ));
        }
        Ok((conversation, run))
    }
    fn save(
        &self,
        scope: &ApplicationScope,
        mut conversation: ComponentAgentConversation,
        run: Option<&StoredComponentRun>,
        tools: &[StoredComponentTool],
        events: &[ComponentAgentEvent],
        now: u64,
    ) -> Result<(), ApplicationError> {
        let expected = conversation.version;
        conversation.version = expected
            .checked_add(1)
            .ok_or_else(|| invalid("Version exhausted"))?;
        conversation.updated_at_ms = now;
        self.store.commit_component(
            scope,
            ComponentWrite {
                expected_version: Some(expected),
                conversation: &conversation,
                run,
                tools,
                events,
            },
        )
    }
    pub fn create(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        profile: ComponentAgentProfile,
        now: u64,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        id(conversation_id)?;
        if let Some(existing) = self
            .store
            .component_conversation(&actor.scope, conversation_id)?
        {
            if existing.controller != actor.window || existing.profile != profile {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok(existing);
        }
        let conversation = ComponentAgentConversation {
            conversation_id: conversation_id.into(),
            title: "New task".into(),
            archived: false,
            version: 1,
            draft_version: 1,
            controller: actor.window.clone(),
            profile,
            draft: String::new(),
            draft_content: AgentDraftContent::default(),
            draft_grant: None,
            active_run_id: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.store.commit_component(
            &actor.scope,
            ComponentWrite {
                expected_version: None,
                conversation: &conversation,
                run: None,
                tools: &[],
                events: &[],
            },
        )?;
        Ok(conversation)
    }
    pub fn save_draft(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        version: u64,
        text: String,
        now: u64,
    ) -> Result<(), ApplicationError> {
        self.save_draft_content(
            actor,
            conversation_id,
            version,
            AgentDraftContent {
                text,
                ..Default::default()
            },
            None,
            now,
        )
    }
    pub fn put_asset(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        asset: &AgentAsset,
        bytes: &[u8],
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        let conversation = self.conversation(actor, conversation_id)?;
        if conversation.archived {
            return Err(invalid("Archived tasks cannot receive attachments"));
        }
        self.store
            .put_component_asset(actor.scope(), conversation_id, asset, bytes)
    }
    pub fn remove_asset(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        asset_id: &str,
        draft_version: u64,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        let mut conversation = self.conversation(actor, conversation_id)?;
        if conversation.archived || conversation.draft_version != draft_version {
            return Err(ApplicationError::Conflict);
        }
        self.store
            .component_asset(actor.scope(), conversation_id, asset_id)?;
        conversation
            .draft_content
            .assets
            .retain(|id| id != asset_id);
        conversation.draft_version = conversation
            .draft_version
            .checked_add(1)
            .ok_or(ApplicationError::Conflict)?;
        // Uploaded bytes remain available to already accepted runs and their history.
        self.save(actor.scope(), conversation, None, &[], &[], now)
    }
    pub fn save_draft_content(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        version: u64,
        content: AgentDraftContent,
        grant: Option<ComponentAgentGrant>,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        if content.text.len() > MAX_COMPONENT_TEXT_BYTES
            || content.context.len() > 16
            || content.assets.len() > 20
            || serde_json::to_vec(&content).map_err(storage)?.len() > 48 * 1024
        {
            return Err(ApplicationError::Budget("Draft exceeds 32 KiB".into()));
        }
        let mut conversation = self.conversation(actor, conversation_id)?;
        if conversation.archived || conversation.draft_version != version {
            return Err(ApplicationError::Conflict);
        }
        if !content.assets.is_empty() {
            let available = self
                .store
                .component_assets(actor.scope(), conversation_id)?;
            let mut seen = std::collections::BTreeSet::new();
            for asset in &content.assets {
                if !seen.insert(asset) || !available.iter().any(|known| &known.asset_id == asset) {
                    return Err(invalid(
                        "Attachment does not belong to this task or was selected twice",
                    ));
                }
            }
        }
        conversation.draft = content.text.clone();
        conversation.draft_content = content;
        conversation.draft_grant = grant;
        conversation.draft_version = version
            .checked_add(1)
            .ok_or_else(|| invalid("Draft version exhausted"))?;
        self.save(&actor.scope, conversation, None, &[], &[], now)
    }
    pub fn update_task_metadata(
        &self,
        actor: &ComponentActor,
        id: &str,
        expected_version: u64,
        title: Option<String>,
        archived: Option<bool>,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        let mut conversation = self.conversation(actor, id)?;
        if conversation.version != expected_version {
            return Err(ApplicationError::Conflict);
        }
        if let Some(title) = title {
            let title = title.trim();
            if title.is_empty() || title.len() > 640 || title.chars().any(char::is_control) {
                return Err(invalid("Task title must contain 1–160 characters"));
            }
            if title.chars().count() > 160 {
                return Err(invalid("Task title exceeds 160 characters"));
            }
            conversation.title = title.into();
        }
        if let Some(archived) = archived {
            conversation.archived = archived;
        }
        self.save(&actor.scope, conversation, None, &[], &[], now)
    }
    pub fn configure(
        &self,
        actor: &ComponentActor,
        settings: &ComponentModelSettings,
        now: u64,
    ) -> Result<ComponentModelSettings, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        if let Some(connection) = &settings.connection {
            validate_component_model(connection)?;
        }
        if settings.enabled && settings.connection.is_none() {
            return Err(invalid("Configure a model before enabling the assistant"));
        }
        let mut updated = settings.clone();
        updated.version = settings
            .version
            .checked_add(1)
            .ok_or_else(|| invalid("Version exhausted"))?;
        self.store
            .write_component_settings(&actor.scope, settings.version, &updated)?;
        Ok(updated)
    }
    pub fn start(
        &self,
        actor: &ComponentActor,
        request: ComponentAgentStart,
        now: u64,
    ) -> Result<ComponentRunAdmission, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        id(&request.request_id)?;
        if request.window != actor.window {
            return Err(ApplicationError::Conflict);
        }
        let digest = component_digest(&request)?;
        if let Some(existing) = self
            .store
            .component_run_by_request(&actor.scope, &request.request_id)?
        {
            if existing.request_digest != digest {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok(ComponentRunAdmission {
                run: existing,
                repeated: true,
            });
        }
        let mut conversation = self.conversation(actor, &request.conversation_id)?;
        if conversation.archived
            || conversation.version != request.conversation_version
            || conversation.active_run_id.is_some()
        {
            return Err(ApplicationError::Conflict);
        }
        if (request.text.trim().is_empty() && request.assets.as_ref().is_none_or(Vec::is_empty))
            || request
                .assets
                .as_ref()
                .is_some_and(|assets| assets.len() > 20)
            || request.text.len() > MAX_COMPONENT_TEXT_BYTES
            || request.sources.len() > 16
            || serde_json::to_vec(&request).map_err(storage)?.len() > 64 * 1024
        {
            return Err(invalid(
                "Assistant input is empty or exceeds its context budget",
            ));
        }
        validate_component_grant(conversation.profile, &request.grant)?;
        self.validate_continuation(&actor.scope, &request)?;
        let settings = self.store.component_settings(&actor.scope)?;
        if !settings.enabled {
            return Err(invalid("Component assistant is disabled"));
        }
        if settings.version != request.model_settings_version {
            return Err(ApplicationError::Conflict);
        }
        let model = settings
            .connection
            .ok_or_else(|| invalid("No component model configured"))?;
        validate_component_model(&model)?;
        if conversation.title.is_empty() || conversation.title == "New task" {
            conversation.title = request
                .text
                .lines()
                .next()
                .unwrap_or("New task")
                .trim()
                .chars()
                .take(80)
                .collect();
        }
        let (task_intent, document_grants) = self.continued_authority(&actor.scope, &request)?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let run = StoredComponentRun {
            request_digest: digest,
            host_incarnation: self.host_incarnation.clone(),
            run: ComponentAgentRun {
                document_grants,
                task_intent,
                permissions: vec![],
                run_id: run_id.clone(),
                profile: conversation.profile,
                budget: budget(),
                request,
                state: ComponentAgentRunState::Queued,
                model,
                model_calls: 0,
                tool_calls: 0,
                tool_result_bytes: 0,
                input_tokens: None,
                output_tokens: None,
                event_cursor: 0,
                created_at_ms: now,
                updated_at_ms: now,
                reason: None,
                context: None,
                document_versions: None,
                recovery: None,
            },
        };
        conversation.active_run_id = Some(run_id);
        self.save(&actor.scope, conversation, Some(&run), &[], &[], now)?;
        Ok(ComponentRunAdmission {
            run,
            repeated: false,
        })
    }
    pub fn claim(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        now: u64,
    ) -> Result<StoredComponentRun, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        if run.run.state != ComponentAgentRunState::Queued {
            return Err(ApplicationError::Conflict);
        }
        run.run.state = ComponentAgentRunState::Running;
        run.run.updated_at_ms = now;
        self.save(scope, conversation, Some(&run), &[], &[], now)?;
        Ok(run)
    }
    pub fn begin_model_call(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        now: u64,
    ) -> Result<u32, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        if run.run.state != ComponentAgentRunState::Running
            || !self.store.component_settings(scope)?.enabled
        {
            return Err(ApplicationError::Conflict);
        }
        if run.run.model_calls >= run.run.budget.model_calls {
            return Err(ApplicationError::Budget(
                "Model call budget exceeded".into(),
            ));
        }
        run.run.model_calls += 1;
        run.run.updated_at_ms = now;
        self.save(scope, conversation, Some(&run), &[], &[], now)?;
        Ok(run.run.model_calls)
    }
    pub fn admit_tool(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        model_call: u32,
        tool_call_id: &str,
        action: ComponentToolAction,
        now: u64,
    ) -> Result<ComponentToolAdmission, ApplicationError> {
        self.admit_tool_call(
            scope,
            run_id,
            ComponentToolCall {
                model_call,
                tool_call_id: tool_call_id.into(),
                origin: None,
            },
            action,
            now,
        )
    }
    pub fn admit_tool_call(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        call: ComponentToolCall,
        action: ComponentToolAction,
        now: u64,
    ) -> Result<ComponentToolAdmission, ApplicationError> {
        self.admit_tool_call_with_precondition(scope, run_id, call, action, None, now)
    }
    /// A fresh owner observation can reject new work, but cannot replace an
    /// already admitted action or prevent reading its original receipt.
    pub fn admit_tool_call_with_precondition(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        call: ComponentToolCall,
        mut action: ComponentToolAction,
        rejection: Option<&str>,
        now: u64,
    ) -> Result<ComponentToolAdmission, ApplicationError> {
        let model_call = call.model_call;
        let tool_call_id = call.tool_call_id.clone();
        if let Some(origin) = &call.origin {
            id(&origin.name)?;
            if origin.arguments_digest.len() != 64
                || !origin
                    .arguments_digest
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit())
            {
                return Err(invalid("Invalid model argument digest"));
            }
        }
        let _guard = self.gate.lock().map_err(storage)?;
        id(&tool_call_id)?;
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        if run.run.state != ComponentAgentRunState::Running
            || model_call == 0
            || model_call != run.run.model_calls
            || !self.store.component_settings(scope)?.enabled
        {
            return Err(ApplicationError::Conflict);
        }
        // Remove caller-generated transport IDs before hashing semantic identity.
        action.bind_request("component-action");
        if let ComponentToolAction::Invoke(invocation) = &mut action {
            invocation.preconditions.sort_by_cached_key(|p| {
                (p.kind.clone(), p.subject.clone(), p.expected.to_string())
            });
            invocation.preconditions.dedup();
        }
        if let ComponentToolAction::Control(command) = &mut action {
            match &mut command.action {
                ApplicationAction::Save {
                    document,
                    target_path,
                }
                | ApplicationAction::RunFile {
                    document,
                    target_path,
                } if target_path.is_none() => {
                    *target_path = component_document_grant(&run.run, &document.document_id)
                        .and_then(|g| g.path.clone());
                }
                _ => {}
            }
        }
        policy::authorize_tool(&run.run, &action)?;
        if serde_json::to_vec(&action).map_err(storage)?.len() > 64 * 1024 {
            return Err(ApplicationError::Budget(
                "Tool arguments exceed 64 KiB".into(),
            ));
        }
        let arguments_digest = component_digest(&action)?;
        let previous_tools = self.store.component_tools(scope, run_id)?;
        if let ComponentToolAction::Invoke(invocation) = &action
            && invocation.capability.id == "workspace.resume_queue"
        {
            let allowed: std::collections::BTreeSet<OperationId> =
                serde_json::from_value(invocation.arguments["only_operation_ids"].clone())
                    .map_err(storage)?;
            if allowed.is_empty()
                || !allowed.is_subset(&self.owned_operations(scope, &run.run, &previous_tools)?)
            {
                return Err(invalid(
                    "Queue resume must be restricted to this run's recorded operations",
                ));
            }
        }
        let ancestors = self.ancestor_runs(scope, &run.run)?;
        let mut prior_tools = Vec::new();
        for ancestor in &ancestors {
            for tool in self.store.component_tools(scope, &ancestor.run.run_id)? {
                prior_tools.push((ancestor, tool));
            }
        }
        let mut semantic_action = action.clone();
        if let ComponentToolAction::Control(command) = &mut semantic_action
            && let ApplicationAction::EditDocument { document, .. } = &mut command.action
            && let Some(grant) = component_document_grant(
                ancestors.last().map_or(&run.run, |r| &r.run),
                &document.document_id,
            )
        {
            *document = grant.document.clone();
        }
        if let ComponentToolAction::Control(command) = &mut semantic_action
            && let ApplicationAction::CreateDocument {
                expected_context_version,
                ..
            }
            | ApplicationAction::OpenDocument {
                expected_context_version,
                ..
            } = &mut command.action
        {
            *expected_context_version = "component-context".into();
        }
        if let ComponentToolAction::Control(command) = &mut semantic_action
            && let ApplicationAction::Save { document, .. }
            | ApplicationAction::RunFile { document, .. }
            | ApplicationAction::RunSelection { document } = &mut command.action
        {
            *document = saved_document_identity(document, &previous_tools)?;
            *document = self.prior_saved_identity(scope, document, &ancestors)?;
        }
        let digest = component_digest(&semantic_action)?;
        if action.mutation() {
            if let Some((ancestor, previous)) = prior_tools.iter().find(|(ancestor, tool)| {
                tool.receipt.mutation
                    && tool.receipt.action_digest == digest
                    && ancestor.run.recovery.as_ref().is_some_and(|r| {
                        r.tools.iter().any(|entry| {
                            entry.receipt_id == tool.receipt.receipt_id
                                && entry.state == ComponentRecoveryState::Confirmed
                        })
                    })
            }) {
                action = ComponentToolAction::PreviousResult {
                    capability: CapabilityRef::new(action.capability(), 1)
                        .map_err(|e| invalid(e.to_string()))?,
                    run_id: ancestor.run.run_id.clone(),
                    receipt_id: previous.receipt.receipt_id.clone(),
                };
            }
        }
        for previous in &previous_tools {
            if previous
                .calls
                .iter()
                .any(|call| call.model_call == model_call && call.tool_call_id == tool_call_id)
            {
                if previous.receipt.action_digest != digest {
                    return Err(ApplicationError::RequestConflict);
                }
                return Ok(ComponentToolAdmission {
                    tool: previous.clone(),
                    repeated: true,
                });
            }
        }
        if run.run.tool_calls >= run.run.budget.tool_calls {
            return Err(ApplicationError::Budget("Tool call budget exceeded".into()));
        }
        if action.mutation()
            && let Some(mut previous) = previous_tools
                .into_iter()
                .find(|p| p.receipt.mutation && p.receipt.action_digest == digest)
        {
            previous.calls.push(call);
            previous.receipt.updated_at_ms = now;
            run.run.tool_calls += 1;
            run.run.updated_at_ms = now;
            self.save(
                scope,
                conversation,
                Some(&run),
                std::slice::from_ref(&previous),
                &[],
                now,
            )?;
            return Ok(ComponentToolAdmission {
                tool: previous,
                repeated: true,
            });
        }
        if action.mutation()
            && let Some(reason) = rejection
        {
            action = ComponentToolAction::Rejected {
                capability: CapabilityRef::new(action.capability(), 1)
                    .map_err(|e| invalid(e.to_string()))?,
                arguments_digest: arguments_digest.clone(),
                feedback: serde_json::json!({"status":"rejected","accepted":false,"error":reason}),
            };
        }
        let client_request_id = uuid::Uuid::new_v4().to_string();
        action.bind_request(&client_request_id);
        let rejected = match &action {
            ComponentToolAction::Rejected { feedback, .. } => Some(feedback.clone()),
            _ => None,
        };
        if let Some(result) = &rejected {
            let bytes = serde_json::to_vec(result).map_err(storage)?.len() as u32;
            let total = run
                .run
                .tool_result_bytes
                .checked_add(bytes)
                .ok_or_else(|| invalid("Tool result size overflow"))?;
            if total > run.run.budget.tool_result_bytes {
                return Err(ApplicationError::Budget(
                    "Tool feedback byte budget exceeded".into(),
                ));
            }
            run.run.tool_result_bytes = total;
        }
        let tool = StoredComponentTool {
            calls: vec![call],
            receipt: ComponentToolReceipt {
                receipt_id: uuid::Uuid::new_v4().to_string(),
                run_id: run_id.into(),
                model_call,
                tool_call_id,
                capability: action.capability().into(),
                arguments_digest,
                action_digest: digest,
                client_request_id,
                mutation: action.mutation(),
                phase: if rejected.is_some() {
                    ComponentToolPhase::Resolved
                } else {
                    ComponentToolPhase::Intent
                },
                operation_id: None,
                application_request_id: None,
                result: rejected,
                evidence: vec![],
                updated_at_ms: now,
            },
            action,
        };
        run.run.tool_calls += 1;
        run.run.updated_at_ms = now;
        self.save(
            scope,
            conversation,
            Some(&run),
            std::slice::from_ref(&tool),
            &[],
            now,
        )?;
        Ok(ComponentToolAdmission {
            tool,
            repeated: false,
        })
    }
    pub fn stop(
        &self,
        actor: &ComponentActor,
        run_id: &str,
        now: u64,
    ) -> Result<StoredComponentRun, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        let mut run = self
            .store
            .component_run(&actor.scope, run_id)?
            .ok_or(ApplicationError::NotFound)?;
        let conversation = self.conversation(actor, &run.run.request.conversation_id)?;
        if run.run.state.is_terminal() || run.run.state == ComponentAgentRunState::Stopping {
            return Ok(run);
        }
        if run.host_incarnation != self.host_incarnation
            || conversation.active_run_id.as_deref() != Some(run_id)
        {
            return Err(ApplicationError::Conflict);
        }
        run.run.state = ComponentAgentRunState::Stopping;
        run.run.updated_at_ms = now;
        self.save(&actor.scope, conversation, Some(&run), &[], &[], now)?;
        Ok(run)
    }
    /// Retain actual owner receipts even after Stop/deadline. This only records
    /// facts; it cannot dispatch or restart the model and never changes run state.
    pub fn record_tool(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        receipt_id: &str,
        update: ComponentToolUpdate,
        now: u64,
    ) -> Result<StoredComponentTool, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let mut run = self
            .store
            .component_run(scope, run_id)?
            .ok_or(ApplicationError::NotFound)?;
        if run.host_incarnation != self.host_incarnation {
            return Err(ApplicationError::Conflict);
        }
        let conversation = self
            .store
            .component_conversation(scope, &run.run.request.conversation_id)?
            .ok_or(ApplicationError::NotFound)?;
        let mut tool = self
            .store
            .component_tools(scope, run_id)?
            .into_iter()
            .find(|t| t.receipt.receipt_id == receipt_id)
            .ok_or(ApplicationError::NotFound)?;
        match update {
            ComponentToolUpdate::Rejected { reason, diagnostic } => {
                if tool.receipt.phase != ComponentToolPhase::Intent || reason.len() > 4096 {
                    return Err(ApplicationError::Conflict);
                }
                tool.receipt.phase = ComponentToolPhase::Resolved;
                tool.receipt.result = Some(
                    serde_json::json!({"status":"rejected","accepted":false,"error":reason,"diagnostic":diagnostic}),
                );
            }
            ComponentToolUpdate::Accepted {
                operation_id,
                application_request_id,
            } => {
                if !tool.receipt.mutation
                    || (operation_id.is_none() && application_request_id.is_none())
                {
                    return Err(invalid(
                        "Mutation acceptance requires its native receipt identity",
                    ));
                }
                if let Some(id) = &application_request_id
                    && id != &tool.receipt.client_request_id
                {
                    return Err(ApplicationError::RequestConflict);
                }
                if !matches!(
                    tool.receipt.phase,
                    ComponentToolPhase::Intent | ComponentToolPhase::Uncertain
                ) {
                    if tool.receipt.operation_id == operation_id
                        && tool.receipt.application_request_id == application_request_id
                    {
                        return Ok(tool);
                    }
                    return Err(ApplicationError::RequestConflict);
                }
                tool.receipt.operation_id = operation_id;
                tool.receipt.application_request_id = application_request_id;
                tool.receipt.phase = ComponentToolPhase::Accepted;
            }
            ComponentToolUpdate::Resolved { result, evidence } => {
                if tool.receipt.mutation && tool.receipt.phase == ComponentToolPhase::Intent {
                    return Err(invalid(
                        "Record the native acceptance before resolving a mutation",
                    ));
                }
                if tool.receipt.phase == ComponentToolPhase::Resolved {
                    if tool.receipt.result.as_ref() == Some(&result)
                        && component_digest(&tool.receipt.evidence)? == component_digest(&evidence)?
                    {
                        return Ok(tool);
                    }
                    return Err(ApplicationError::RequestConflict);
                }
                if evidence.len() > 32 {
                    return Err(ApplicationError::Budget(
                        "Too many tool evidence references".into(),
                    ));
                }
                if let ComponentToolAction::Control(command) = &tool.action
                    && let ApplicationAction::OpenDocument { path, .. }
                    | ApplicationAction::CreateDocument {
                        path: Some(path), ..
                    } = &command.action
                {
                    let receipt: ApplicationCommandReceipt =
                        serde_json::from_value(result.clone()).map_err(storage)?;
                    if receipt.request_id != tool.receipt.client_request_id
                        || receipt.window != run.run.request.window
                    {
                        return Err(ApplicationError::RequestConflict);
                    }
                    if receipt.state == ApplicationCommandState::Applied {
                        let summary = receipt
                            .applied_document_summaries
                            .as_ref()
                            .and_then(|summaries| {
                                summaries
                                    .iter()
                                    .find(|summary| summary.path.as_ref() == Some(path))
                            })
                            .filter(|summary| {
                                receipt
                                    .applied_documents
                                    .as_ref()
                                    .is_some_and(|docs| docs.contains(&summary.document))
                            })
                            .ok_or_else(|| {
                                invalid(
                                    "Opened document identity is missing from its owner receipt",
                                )
                            })?;
                        let entry = ComponentDocumentGrant {
                            document: summary.document.clone(),
                            allow_save: summary.readonly_reason.is_none(),
                            path: Some(path.clone()),
                        };
                        let existing =
                            run.run.document_grants.iter().position(|g| {
                                g.document.document_id == summary.document.document_id
                            });
                        if let Some(index) = existing {
                            run.run.document_grants[index] = entry;
                        } else {
                            if run.run.document_grants.len() + run.run.request.grant.documents.len()
                                >= 16
                            {
                                return Err(ApplicationError::Budget(
                                    "Task document target limit reached".into(),
                                ));
                            }
                            run.run.document_grants.push(entry);
                        }
                        run.run
                            .document_versions
                            .get_or_insert_with(Default::default)
                            .insert(
                                summary.document.document_id.clone(),
                                summary.document.clone(),
                            );
                    }
                }
                if let ComponentToolAction::Control(command) = &tool.action
                    && let ApplicationAction::EditDocument { document, .. }
                    | ApplicationAction::Save { document, .. }
                    | ApplicationAction::RunFile { document, .. } = &command.action
                {
                    let receipt: ApplicationCommandReceipt =
                        serde_json::from_value(result.clone()).map_err(storage)?;
                    if receipt.request_id != tool.receipt.client_request_id
                        || receipt.window != run.run.request.window
                    {
                        return Err(ApplicationError::RequestConflict);
                    }
                    let applied = receipt.applied_documents.as_ref().and_then(|documents| {
                        documents
                            .iter()
                            .find(|updated| updated.document_id == document.document_id)
                    });
                    let edited = matches!(command.action, ApplicationAction::EditDocument { .. })
                        && receipt.state == ApplicationCommandState::Applied;
                    if edited && applied.is_none() {
                        return Err(invalid(
                            "Applied document version is missing from the native receipt",
                        ));
                    }
                    if let Some(applied) = applied
                        && (edited || receipt.save_synchronized == Some(true))
                    {
                        if component_document_reference(&run.run, &document.document_id)
                            != Some(document)
                        {
                            return Err(ApplicationError::Conflict);
                        }
                        run.run
                            .document_versions
                            .get_or_insert_with(Default::default)
                            .insert(document.document_id.clone(), applied.clone());
                    }
                }
                let bytes = serde_json::to_vec(&result).map_err(storage)?.len();
                let total = (run.run.tool_result_bytes as usize)
                    .checked_add(bytes)
                    .ok_or_else(|| invalid("Tool result size overflow"))?;
                if total > run.run.budget.tool_result_bytes as usize {
                    return Err(ApplicationError::Budget(
                        "Tool result byte budget exceeded; original owner receipt retained".into(),
                    ));
                }
                run.run.tool_result_bytes = total as u32;
                tool.receipt.result = Some(result);
                tool.receipt.evidence = evidence;
                tool.receipt.phase = ComponentToolPhase::Resolved;
            }
            ComponentToolUpdate::Uncertain { reason } => {
                if reason.len() > 4096 || tool.receipt.phase == ComponentToolPhase::Resolved {
                    return Err(ApplicationError::Conflict);
                }
                tool.receipt.phase = ComponentToolPhase::Uncertain;
                tool.receipt.result =
                    Some(serde_json::json!({"status":"uncertain","reason":reason}));
            }
        }
        tool.receipt.updated_at_ms = now;
        run.run.updated_at_ms = now;
        run.run.event_cursor += 1;
        let event = ComponentAgentEvent {
            run_id: run_id.into(),
            sequence: run.run.event_cursor,
            created_at_ms: now,
            content: ComponentAgentEventContent::Tool {
                receipt_id: receipt_id.into(),
                phase: tool.receipt.phase,
            },
        };
        self.save(
            scope,
            conversation,
            Some(&run),
            std::slice::from_ref(&tool),
            &[event],
            now,
        )?;
        Ok(tool)
    }
    pub fn finish(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        state: ComponentAgentRunState,
        reason: Option<String>,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        if !state.is_terminal() || reason.as_ref().is_some_and(|r| r.len() > 4096) {
            return Err(invalid("Invalid terminal state or reason"));
        }
        let mut run = self
            .store
            .component_run(scope, run_id)?
            .ok_or(ApplicationError::NotFound)?;
        let mut conversation = self
            .store
            .component_conversation(scope, &run.run.request.conversation_id)?
            .ok_or(ApplicationError::NotFound)?;
        if run.host_incarnation != self.host_incarnation
            || conversation.active_run_id.as_deref() != Some(run_id)
            || run.run.state.is_terminal()
        {
            return Err(ApplicationError::Conflict);
        }
        if run.run.state == ComponentAgentRunState::Stopping
            && state == ComponentAgentRunState::Completed
        {
            return Err(ApplicationError::Conflict);
        }
        run.run.state = state;
        run.run.reason = reason.clone();
        run.run.updated_at_ms = now;
        run.run.event_cursor += 1;
        conversation.active_run_id = None;
        let event = ComponentAgentEvent {
            run_id: run_id.into(),
            sequence: run.run.event_cursor,
            created_at_ms: now,
            content: ComponentAgentEventContent::State { state, reason },
        };
        self.save(scope, conversation, Some(&run), &[], &[event], now)
    }
    pub fn record_diagnostic(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        diagnostic: Diagnostic,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        if serde_json::to_vec(&diagnostic).map_err(storage)?.len() > 16 * 1024 {
            return Err(ApplicationError::Budget(
                "Diagnostic exceeds the task event budget".into(),
            ));
        }
        let mut run = self
            .store
            .component_run(scope, run_id)?
            .ok_or(ApplicationError::NotFound)?;
        if run.host_incarnation != self.host_incarnation {
            return Err(ApplicationError::Conflict);
        }
        let conversation = self
            .store
            .component_conversation(scope, &run.run.request.conversation_id)?
            .ok_or(ApplicationError::NotFound)?;
        run.run.event_cursor += 1;
        run.run.updated_at_ms = now;
        let event = ComponentAgentEvent {
            run_id: run_id.into(),
            sequence: run.run.event_cursor,
            created_at_ms: now,
            content: ComponentAgentEventContent::Diagnostic { diagnostic },
        };
        self.save(scope, conversation, Some(&run), &[], &[event], now)
    }
    pub fn append_text(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        text: String,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        if text.is_empty() || text.len() > 8192 {
            return Err(invalid("Invalid assistant text fragment"));
        }
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        if run.run.state != ComponentAgentRunState::Running {
            return Err(ApplicationError::Conflict);
        }
        run.run.event_cursor += 1;
        run.run.updated_at_ms = now;
        let event = ComponentAgentEvent {
            run_id: run_id.into(),
            sequence: run.run.event_cursor,
            created_at_ms: now,
            content: ComponentAgentEventContent::Text { text },
        };
        self.save(scope, conversation, Some(&run), &[], &[event], now)
    }

    pub fn record_usage(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        run.run.input_tokens = input_tokens;
        run.run.output_tokens = output_tokens;
        run.run.updated_at_ms = now;
        self.save(scope, conversation, Some(&run), &[], &[], now)
    }
    pub fn native_wait_state(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        state: ComponentAgentRunState,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        if !matches!(
            state,
            ComponentAgentRunState::Running
                | ComponentAgentRunState::WaitingForR
                | ComponentAgentRunState::NeedsInput
        ) {
            return Err(invalid("Invalid native wait state"));
        }
        let mut run = self
            .store
            .component_run(scope, run_id)?
            .ok_or(ApplicationError::NotFound)?;
        if run.host_incarnation != self.host_incarnation {
            return Err(ApplicationError::Conflict);
        }
        if run.run.state == state
            || run.run.state == ComponentAgentRunState::Stopping
            || run.run.state.is_terminal()
        {
            return Ok(());
        }
        let conversation = self
            .store
            .component_conversation(scope, &run.run.request.conversation_id)?
            .ok_or(ApplicationError::NotFound)?;
        if conversation.active_run_id.as_deref() != Some(run_id) {
            return Err(ApplicationError::Conflict);
        }
        run.run.state = state;
        run.run.updated_at_ms = now;
        run.run.event_cursor += 1;
        let event = ComponentAgentEvent {
            run_id: run_id.into(),
            sequence: run.run.event_cursor,
            created_at_ms: now,
            content: ComponentAgentEventContent::State {
                state,
                reason: None,
            },
        };
        self.save(scope, conversation, Some(&run), &[], &[event], now)
    }

    pub fn check_tool_dispatch(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        receipt_id: &str,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let (_, run) = self.active(scope, run_id, now)?;
        if run.run.state != ComponentAgentRunState::Running
            || !self.store.component_settings(scope)?.enabled
        {
            return Err(ApplicationError::Conflict);
        }
        let tools = self.store.component_tools(scope, run_id)?;
        if run.run.request.grant.permission_policy.is_some()
            && tools
                .iter()
                .any(|t| t.receipt.receipt_id == receipt_id && t.action.requires_permission())
            && !run.run.permissions.iter().any(|permission| {
                permission.receipt_id == receipt_id
                    && permission.state == ComponentPermissionState::Allowed
                    && tools.iter().any(|tool| {
                        tool.receipt.receipt_id == receipt_id
                            && tool.receipt.action_digest == permission.action_digest
                    })
            })
        {
            return Err(invalid("This action has no recorded permission"));
        }
        if tools.iter().any(|t| {
            t.receipt.receipt_id == receipt_id && t.receipt.phase == ComponentToolPhase::Intent
        }) {
            Ok(())
        } else {
            Err(ApplicationError::Conflict)
        }
    }

    pub fn capture_context(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        context: ComponentAgentContext,
        now: u64,
    ) -> Result<(), ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let (conversation, mut run) = self.active(scope, run_id, now)?;
        if run.run.state != ComponentAgentRunState::Queued || run.run.context.is_some() {
            return Err(ApplicationError::Conflict);
        }
        if context.sources.len() > 16
            || serde_json::to_vec(&context).map_err(storage)?.len() > 64 * 1024
        {
            return Err(ApplicationError::Budget(
                "Selected context exceeds 64 KiB".into(),
            ));
        }
        run.run.context = Some(context);
        run.run.updated_at_ms = now;
        self.save(scope, conversation, Some(&run), &[], &[], now)
    }
}

#[cfg(test)]
mod tests;
