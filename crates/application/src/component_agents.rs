//! Transitional typed adapter to the public Agent task owner. No state machine.
use crate::{ApplicationError, ApplicationOwner, ApplicationScope};
use rho_agent_owner::component as public;
use rho_contract::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
mod bridge;
use bridge::*;

mod engine;
pub use engine::*;

/// Issued from a live, authenticated Application window, never deserialized.
#[derive(Clone)]
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
    pub(crate) fn validate(&self, now: u64) -> Result<(), ApplicationError> {
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

pub use public::{
    MAX_COMPONENT_CONVERSATION_RECORD_BYTES, MAX_COMPONENT_CONVERSATIONS,
    MAX_COMPONENT_DIAGNOSTIC_RECORD_BYTES, MAX_COMPONENT_EVENT_BYTES, MAX_COMPONENT_EVENTS,
    MAX_COMPONENT_PROJECT_EVENT_BYTES, MAX_COMPONENT_PROJECT_PAYLOAD_BYTES,
    MAX_COMPONENT_QUEUED_RUNS, MAX_COMPONENT_RUN_RECORD_BYTES, MAX_COMPONENT_RUNNING_RUNS,
    MAX_COMPONENT_SETTINGS_RECORD_BYTES, MAX_COMPONENT_TEXT_BYTES, MAX_COMPONENT_TOOL_RECORD_BYTES,
    component_query_allowed,
};

impl public::ComponentActorValidator for ComponentActor {
    fn validate(&self, now: u64) -> Result<(), public::ComponentTaskError> {
        ComponentActor::validate(self, now).map_err(Into::into)
    }
}
impl ComponentActor {
    fn public(&self) -> public::ComponentActor {
        public::ComponentActor::new(
            public_scope(&self.scope),
            rho_agent_api::AgentControllerRef {
                window_id: self.window.window_id.clone(),
                incarnation: self.window.incarnation.clone(),
            },
            Arc::new(self.clone()),
        )
    }
}

pub struct ComponentAgentOwner {
    pub store: Arc<dyn ComponentAgentRepository>,
    pub host_incarnation: String,
    inner: public::ComponentAgentOwner,
}
impl ComponentAgentOwner {
    pub fn new(store: Arc<dyn ComponentAgentRepository>, host_incarnation: String) -> Self {
        let inner = public::ComponentAgentOwner::new(
            Arc::new(RepositoryAdapter(store.clone())),
            host_incarnation.clone(),
        );
        Self {
            store,
            host_incarnation,
            inner,
        }
    }
    pub fn with_handoff_write<T>(
        &self,
        write: impl FnOnce() -> Result<T, ApplicationError>,
    ) -> Result<T, ApplicationError> {
        self.inner.with_handoff_write(write)
    }
    pub fn begin_model_test(
        &self,
        actor: &ComponentActor,
        request: &ComponentModelTestRequest,
        now: u64,
    ) -> Result<(ComponentModelDiagnostic, bool), ApplicationError> {
        wire(
            &self
                .inner
                .begin_model_test(&actor.public(), &wire(request)?, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn update_model_test(
        &self,
        scope: &ApplicationScope,
        request_id: &str,
        state: ComponentModelTestState,
        detail: Option<String>,
        now: u64,
    ) -> Result<ComponentModelDiagnostic, ApplicationError> {
        wire(
            &self
                .inner
                .update_model_test(&public_scope(scope), request_id, state, detail, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn create(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        profile: ComponentAgentProfile,
        now: u64,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        wire(
            &self
                .inner
                .create(&actor.public(), conversation_id, profile, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn save_draft(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        version: u64,
        text: String,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .save_draft(&actor.public(), conversation_id, version, text, now)
                .map_err(ApplicationError::from)?,
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
        wire(
            &self
                .inner
                .put_asset(&actor.public(), conversation_id, asset, bytes, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn remove_asset(
        &self,
        actor: &ComponentActor,
        conversation_id: &str,
        asset_id: &str,
        draft_version: u64,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .remove_asset(
                    &actor.public(),
                    conversation_id,
                    asset_id,
                    draft_version,
                    now,
                )
                .map_err(ApplicationError::from)?,
        )
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
        wire(
            &self
                .inner
                .save_draft_content(
                    &actor.public(),
                    conversation_id,
                    version,
                    content,
                    wire(&grant)?,
                    now,
                )
                .map_err(ApplicationError::from)?,
        )
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
        wire(
            &self
                .inner
                .update_task_metadata(&actor.public(), id, expected_version, title, archived, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn configure(
        &self,
        actor: &ComponentActor,
        settings: &ComponentModelSettings,
        now: u64,
    ) -> Result<ComponentModelSettings, ApplicationError> {
        wire(
            &self
                .inner
                .configure(&actor.public(), settings, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn start(
        &self,
        actor: &ComponentActor,
        request: ComponentAgentStart,
        now: u64,
    ) -> Result<ComponentRunAdmission, ApplicationError> {
        wire(
            &self
                .inner
                .start(&actor.public(), wire(&request)?, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn claim(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        now: u64,
    ) -> Result<StoredComponentRun, ApplicationError> {
        wire(
            &self
                .inner
                .claim(&public_scope(scope), run_id, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn begin_model_call(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        now: u64,
    ) -> Result<u32, ApplicationError> {
        wire(
            &self
                .inner
                .begin_model_call(&public_scope(scope), run_id, now)
                .map_err(ApplicationError::from)?,
        )
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
        wire(
            &self
                .inner
                .admit_tool(
                    &public_scope(scope),
                    run_id,
                    model_call,
                    tool_call_id,
                    wire(&action)?,
                    now,
                )
                .map_err(ApplicationError::from)?,
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
        wire(
            &self
                .inner
                .admit_tool_call(
                    &public_scope(scope),
                    run_id,
                    wire(&call)?,
                    wire(&action)?,
                    now,
                )
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn admit_tool_call_with_precondition(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        call: ComponentToolCall,
        action: ComponentToolAction,
        rejection: Option<&str>,
        now: u64,
    ) -> Result<ComponentToolAdmission, ApplicationError> {
        wire(
            &self
                .inner
                .admit_tool_call_with_precondition(
                    &public_scope(scope),
                    run_id,
                    wire(&call)?,
                    wire(&action)?,
                    rejection,
                    now,
                )
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn stop(
        &self,
        actor: &ComponentActor,
        run_id: &str,
        now: u64,
    ) -> Result<StoredComponentRun, ApplicationError> {
        wire(
            &self
                .inner
                .stop(&actor.public(), run_id, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn record_tool(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        receipt_id: &str,
        update: ComponentToolUpdate,
        now: u64,
    ) -> Result<StoredComponentTool, ApplicationError> {
        wire(
            &self
                .inner
                .record_tool(
                    &public_scope(scope),
                    run_id,
                    receipt_id,
                    wire(&update)?,
                    now,
                )
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn finish(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        state: ComponentAgentRunState,
        reason: Option<String>,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .finish(&public_scope(scope), run_id, wire(&state)?, reason, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn record_diagnostic(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        diagnostic: Diagnostic,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .record_diagnostic(&public_scope(scope), run_id, wire(&diagnostic)?, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn append_text(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        text: String,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .append_text(&public_scope(scope), run_id, text, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn record_usage(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .record_usage(
                    &public_scope(scope),
                    run_id,
                    wire(&input_tokens)?,
                    wire(&output_tokens)?,
                    now,
                )
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn native_wait_state(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        state: ComponentAgentRunState,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .native_wait_state(&public_scope(scope), run_id, wire(&state)?, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn check_tool_dispatch(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        receipt_id: &str,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .check_tool_dispatch(&public_scope(scope), run_id, receipt_id, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn capture_context(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        context: ComponentAgentContext,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .capture_context(&public_scope(scope), run_id, wire(&context)?, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn ancestor_runs(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
    ) -> Result<Vec<StoredComponentRun>, ApplicationError> {
        wire(
            &self
                .inner
                .ancestor_runs(&public_scope(scope), &wire(run)?)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn confirmed_document(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
        initial: &ApplicationDocumentRef,
    ) -> Result<ApplicationDocumentRef, ApplicationError> {
        wire(
            &self
                .inner
                .confirmed_document(&public_scope(scope), &wire(run)?, &wire(initial)?)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn previous_tool(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
        source_run: &str,
        receipt: &str,
    ) -> Result<(StoredComponentRun, StoredComponentTool), ApplicationError> {
        wire(
            &self
                .inner
                .previous_tool(&public_scope(scope), &wire(run)?, source_run, receipt)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn owned_operations(
        &self,
        scope: &ApplicationScope,
        run: &ComponentAgentRun,
        current: &[StoredComponentTool],
    ) -> Result<std::collections::BTreeSet<OperationId>, ApplicationError> {
        wire(
            &self
                .inner
                .owned_operations(
                    &public_scope(scope),
                    &wire(run)?,
                    &wire::<_, Vec<public::StoredComponentTool>>(current)?,
                )
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn capture_task_intent(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        intent: &ComponentAgentTaskIntent,
        now: u64,
    ) -> Result<(), ApplicationError> {
        wire(
            &self
                .inner
                .capture_task_intent(&public_scope(scope), run_id, &wire(intent)?, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn record_permission(
        &self,
        scope: &ApplicationScope,
        run_id: &str,
        receipt_id: &str,
        tool_name: &str,
        authorization: ComponentTaskAuthorization,
        allowed: bool,
        now: u64,
    ) -> Result<ComponentAgentPermission, ApplicationError> {
        wire(
            &self
                .inner
                .record_permission(
                    &public_scope(scope),
                    run_id,
                    receipt_id,
                    tool_name,
                    authorization,
                    allowed,
                    now,
                )
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn decide_permission(
        &self,
        actor: &ComponentActor,
        run_id: &str,
        decision_id: &str,
        allow: bool,
        now: u64,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        wire(
            &self
                .inner
                .decide_permission(&actor.public(), run_id, decision_id, allow, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn observed_run(
        &self,
        run: StoredComponentRun,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        wire(&self.inner.observed_run(wire(&run)?))
    }
    pub fn interrupt_abandoned(
        &self,
        scope: &ApplicationScope,
        id: &str,
        now: u64,
    ) -> Result<StoredComponentRun, ApplicationError> {
        wire(
            &self
                .inner
                .interrupt_abandoned(&public_scope(scope), id, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn take_control(
        &self,
        actor: &ComponentActor,
        id: &str,
        expected_version: u64,
        now: u64,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        wire(
            &self
                .inner
                .take_control(&actor.public(), id, expected_version, now)
                .map_err(ApplicationError::from)?,
        )
    }
    pub fn record_recovery(
        &self,
        scope: &ApplicationScope,
        id: &str,
        tools: Vec<ComponentRecoveredTool>,
        now: u64,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        wire(
            &self
                .inner
                .record_recovery(&public_scope(scope), id, wire(&tools)?, now)
                .map_err(ApplicationError::from)?,
        )
    }
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

pub fn component_owned_operations(
    tools: &[StoredComponentTool],
) -> Result<std::collections::BTreeSet<OperationId>, ApplicationError> {
    wire(
        &public::component_owned_operations(&wire::<_, Vec<public::StoredComponentTool>>(tools)?)
            .map_err(ApplicationError::from)?,
    )
}
pub fn component_digest(value: &impl Serialize) -> Result<String, ApplicationError> {
    public::component_digest(value).map_err(Into::into)
}
pub fn validate_component_model(model: &ComponentModelConnection) -> Result<(), ApplicationError> {
    public::validate_component_model(model).map_err(Into::into)
}
pub fn validate_component_grant(
    profile: ComponentAgentProfile,
    grant: &ComponentAgentGrant,
) -> Result<(), ApplicationError> {
    public::validate_component_grant(profile, &wire(grant)?).map_err(Into::into)
}
pub fn component_query_available(run: &ComponentAgentRun, capability: &str) -> bool {
    wire(run).is_ok_and(|run| public::component_query_available(&run, capability))
}
