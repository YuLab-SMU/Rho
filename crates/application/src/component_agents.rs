//! Durable admission for optional component assistants. No model or native dispatch.
use crate::{ApplicationError, ApplicationOwner, ApplicationScope};
use rho_contract::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

mod engine;
mod policy;
pub use engine::*;
pub use policy::{component_query_allowed, validate_component_grant, validate_component_model};

pub const MAX_COMPONENT_CONVERSATIONS: usize = 4096;
pub const MAX_COMPONENT_EVENTS: usize = 500;
pub const MAX_COMPONENT_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_COMPONENT_PROJECT_EVENT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_COMPONENT_QUEUED_RUNS: usize = 10; // two running plus eight waiting
pub const MAX_COMPONENT_RUNNING_RUNS: usize = 2;
pub const MAX_COMPONENT_TEXT_BYTES: usize = 32 * 1024;

/// Issued from a live, authenticated Application window, never deserialized.
pub struct ComponentActor {
    scope: ApplicationScope,
    window: ApplicationWindowRef,
    application_store: Arc<dyn crate::ApplicationRepository>,
    application_host: String,
}
impl ComponentActor {
    pub fn scope(&self) -> &ApplicationScope {
        &self.scope
    }
    pub fn window(&self) -> &ApplicationWindowRef {
        &self.window
    }
    fn validate(&self, now: u64) -> Result<(), ApplicationError> {
        let current = self
            .application_store
            .window(&self.scope, &self.window.window_id)?
            .ok_or(ApplicationError::NotFound)?;
        if current.window != self.window {
            return Err(ApplicationError::IncarnationChanged);
        }
        if current.host_incarnation != self.application_host
            || now
                >= current
                    .renewed_at_ms
                    .saturating_add(crate::OFFLINE_AFTER_MS)
        {
            return Err(ApplicationError::Offline);
        }
        Ok(())
    }
}
impl ApplicationOwner {
    pub fn component_actor(
        &self,
        context: &CallContext,
        window: &ApplicationWindowRef,
        now: u64,
    ) -> Result<ComponentActor, ApplicationError> {
        let scope = self.scope(context)?;
        self.require_online(&self.load_window(&scope, window)?, now)?;
        Ok(ComponentActor {
            scope,
            window: window.clone(),
            application_store: self.store.clone(),
            application_host: self.host_incarnation.clone(),
        })
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
    Query(QueryRequest),
    Invoke(Invocation),
    Control(ApplicationCommandRequest),
}
impl ComponentToolAction {
    pub fn capability(&self) -> &str {
        match self {
            Self::Query(q) => &q.capability.id,
            Self::Invoke(i) => &i.capability.id,
            Self::Control(_) => "application.control",
        }
    }
    pub fn mutation(&self) -> bool {
        !matches!(self, Self::Query(_))
    }
    fn bind_request(&mut self, id: &str) {
        match self {
            Self::Invoke(i) => i.client_request_id = id.into(),
            Self::Control(c) => c.request_id = id.into(),
            Self::Query(_) => {}
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
}

pub struct ComponentWrite<'a> {
    pub expected_version: Option<u64>,
    pub conversation: &'a ComponentAgentConversation,
    pub run: Option<&'a StoredComponentRun>,
    pub tools: &'a [StoredComponentTool],
    pub events: &'a [ComponentAgentEvent],
}

pub trait ComponentAgentRepository: Send + Sync {
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

pub struct ComponentRunAdmission {
    pub run: StoredComponentRun,
    pub repeated: bool,
}
pub struct ComponentToolAdmission {
    pub tool: StoredComponentTool,
    pub repeated: bool,
}
pub enum ComponentToolUpdate {
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
fn budget(mode: ComponentAgentMode) -> ComponentAgentBudget {
    let (model_calls, tool_calls) = match mode {
        ComponentAgentMode::Explain => (4, 8),
        ComponentAgentMode::Edit => (6, 12),
        ComponentAgentMode::Run => (8, 16),
    };
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
            version: 1,
            draft_version: 1,
            controller: actor.window.clone(),
            profile,
            draft: String::new(),
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
        let _guard = self.gate.lock().map_err(storage)?;
        actor.validate(now)?;
        if text.len() > MAX_COMPONENT_TEXT_BYTES {
            return Err(ApplicationError::Budget("Draft exceeds 32 KiB".into()));
        }
        let mut conversation = self.conversation(actor, conversation_id)?;
        if conversation.draft_version != version {
            return Err(ApplicationError::Conflict);
        }
        conversation.draft = text;
        conversation.draft_version = version
            .checked_add(1)
            .ok_or_else(|| invalid("Draft version exhausted"))?;
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
        if conversation.version != request.conversation_version
            || conversation.active_run_id.is_some()
        {
            return Err(ApplicationError::Conflict);
        }
        if request.text.trim().is_empty()
            || request.text.len() > MAX_COMPONENT_TEXT_BYTES
            || request.sources.len() > 16
            || serde_json::to_vec(&request).map_err(storage)?.len() > 64 * 1024
        {
            return Err(invalid(
                "Assistant input is empty or exceeds its context budget",
            ));
        }
        validate_component_grant(conversation.profile, &request.grant)?;
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
        let run_id = uuid::Uuid::new_v4().to_string();
        let run = StoredComponentRun {
            request_digest: digest,
            host_incarnation: self.host_incarnation.clone(),
            run: ComponentAgentRun {
                run_id: run_id.clone(),
                profile: conversation.profile,
                budget: budget(request.grant.mode),
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
        mut action: ComponentToolAction,
        now: u64,
    ) -> Result<ComponentToolAdmission, ApplicationError> {
        let _guard = self.gate.lock().map_err(storage)?;
        id(tool_call_id)?;
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
                    *target_path = run
                        .run
                        .request
                        .grant
                        .documents
                        .iter()
                        .find(|g| g.document == *document)
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
        let digest = component_digest(&action)?;
        let previous_tools = self.store.component_tools(scope, run_id)?;
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
        let call = ComponentToolCall {
            model_call,
            tool_call_id: tool_call_id.into(),
        };
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
        let client_request_id = uuid::Uuid::new_v4().to_string();
        action.bind_request(&client_request_id);
        let tool = StoredComponentTool {
            calls: vec![call],
            receipt: ComponentToolReceipt {
                receipt_id: uuid::Uuid::new_v4().to_string(),
                run_id: run_id.into(),
                model_call,
                tool_call_id: tool_call_id.into(),
                capability: action.capability().into(),
                arguments_digest: digest.clone(),
                action_digest: digest,
                client_request_id,
                mutation: action.mutation(),
                phase: ComponentToolPhase::Intent,
                operation_id: None,
                application_request_id: None,
                result: None,
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
                if tool.receipt.phase != ComponentToolPhase::Intent {
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
