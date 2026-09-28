#![forbid(unsafe_code)]
//! One writer for persistent Agent application metadata. Native actions are
//! admitted here before the Host adapter touches a process or transport.
use rho_agent_api::*;
mod native_admission;
pub use native_admission::*;
mod native_host;
pub use native_host::*;
mod native_tools;
pub use native_tools::*;
mod boundary;
pub use boundary::*;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

pub const MAX_AGENT_TASKS: usize = 4096;
pub const MAX_AGENT_DRAFT_BYTES: usize = 32 * 1024;
pub const MAX_AGENT_EVENTS: usize = 500;
pub const MAX_AGENT_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_PROJECT_AGENT_EVENT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOwnedProcess {
    pub pid: u32,
    pub start_time: u64,
    pub executable: String,
    pub marker: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAgentTask {
    /// Older supported tasks keep their original caller-scoped dedup namespace.
    #[serde(default)]
    pub task_mcp_identity: bool,
    pub task: AgentTask,
    pub attachment: AgentAttachment,
    pub revision: String,
    pub observation_version: u64,
    pub host_incarnation: String,
    pub process: Option<AgentOwnedProcess>,
    pub active_request: Option<String>,
    pub automatic_title: bool,
    pub event_cursor: u64,
    pub history_gap: bool,
    pub interrupted_context: bool,
    pub history_generation: u64,
    pub native_quiet: bool,
}

pub struct AgentTaskWrite<'a> {
    pub expected_revision: Option<&'a str>,
    pub task: &'a StoredAgentTask,
    pub draft: Option<&'a AgentTaskDraft>,
    pub receipts: &'a [AgentCommandReceipt],
    pub events: &'a [AgentTaskEvent],
}

pub trait AgentTaskRepository: Send + Sync {
    /// Bounded projection of the two existing task owners in one read snapshot.
    fn project_agent_tasks(
        &self,
        _scope: &AgentTaskScope,
        _archived: Option<bool>,
        _before: Option<&str>,
        _limit: usize,
        _native_host: &str,
        _rho_host: &str,
        _rho_live: &[String],
    ) -> Result<ProjectAgentTaskPage, AgentTaskError> {
        Err(AgentTaskError::Storage(
            "Unified task reading is unavailable".into(),
        ))
    }
    fn agent_task(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<StoredAgentTask>, AgentTaskError>;
    fn agent_tasks(
        &self,
        scope: &AgentTaskScope,
        archived: Option<bool>,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<StoredAgentTask>, AgentTaskError>;
    fn agent_task_counts(
        &self,
        scope: &AgentTaskScope,
        host: &str,
    ) -> Result<(u32, u32), AgentTaskError>;
    fn agent_draft(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<AgentTaskDraft, AgentTaskError>;
    fn agent_receipt(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<AgentCommandReceipt>, AgentTaskError>;
    fn agent_receipts(
        &self,
        scope: &AgentTaskScope,
        task: &str,
    ) -> Result<Vec<AgentCommandReceipt>, AgentTaskError>;
    fn agent_events(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        after: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> Result<AgentTaskEventPage, AgentTaskError>;
    fn agent_assets(
        &self,
        scope: &AgentTaskScope,
        task: &str,
    ) -> Result<Vec<AgentAsset>, AgentTaskError>;
    fn agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), AgentTaskError>;
    fn put_agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &AgentAsset,
        bytes: &[u8],
    ) -> Result<(), AgentTaskError>;
    fn agent_native_admission(
        &self,
        _scope: &AgentTaskScope,
        _request_id: &str,
    ) -> Result<Option<StoredAgentNativeAdmission>, AgentTaskError> {
        Err(AgentTaskError::Storage(
            "Native admission observations are unavailable".into(),
        ))
    }
    /// Persist original capture and receipt in the same task transaction.
    fn commit_agent_native_admission(
        &self,
        _scope: &AgentTaskScope,
        _write: AgentTaskWrite<'_>,
        _admission: &StoredAgentNativeAdmission,
    ) -> Result<(), AgentTaskError> {
        Err(AgentTaskError::Storage(
            "Atomic native admission is unavailable".into(),
        ))
    }
    fn agent_native_tool(
        &self,
        _scope: &AgentTaskScope,
        _send: &str,
        _tool: &str,
    ) -> Result<Option<AgentNativeToolReceipt>, AgentTaskError> {
        Err(AgentTaskError::Storage(
            "Native tool observations are unavailable".into(),
        ))
    }
    fn put_agent_native_tool(
        &self,
        _scope: &AgentTaskScope,
        _receipt: &AgentNativeToolReceipt,
    ) -> Result<(), AgentTaskError> {
        Err(AgentTaskError::Storage(
            "Native tool storage is unavailable".into(),
        ))
    }
    fn commit_agent_task(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
    ) -> Result<(), AgentTaskError>;
}

pub struct AgentTaskAdmission {
    pub task: StoredAgentTask,
    pub receipt: AgentCommandReceipt,
    pub draft: AgentTaskDraft,
    pub repeated: bool,
    pub native: bool,
}

pub struct AgentTaskOwner {
    pub store: Arc<dyn AgentTaskRepository>,
    pub host_incarnation: String,
    gate: Mutex<()>,
}

impl AgentTaskOwner {
    pub fn with_handoff_write<T, E: From<AgentTaskError>>(
        &self,
        write: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| AgentTaskError::Storage("Agent metadata lock poisoned".into()))?;
        write()
    }
}

pub fn agent_command_name(command: &AgentTaskCommand) -> &'static str {
    match command {
        AgentTaskCommand::Create { .. } => "create",
        AgentTaskCommand::SaveDraft { .. } => "save_draft",
        AgentTaskCommand::Rename { .. } => "rename",
        AgentTaskCommand::Archive { .. } => "archive",
        AgentTaskCommand::Connect { .. } => "connect",
        AgentTaskCommand::Resume { .. } => "resume",
        AgentTaskCommand::Disconnect { .. } => "disconnect",
        AgentTaskCommand::TakeOver { .. } => "take_over",
        AgentTaskCommand::Send { .. } => "send",
        AgentTaskCommand::Configure { .. } => "configure",
        AgentTaskCommand::Stop { .. } => "stop",
        AgentTaskCommand::Decision { .. } => "decision",
        AgentTaskCommand::AddAsset { .. } => "add_asset",
        AgentTaskCommand::RemoveAsset { .. } => "remove_asset",
    }
}
pub fn agent_control(command: &AgentTaskCommand) -> Option<&AgentTaskControl> {
    match command {
        AgentTaskCommand::Create { .. } => None,
        AgentTaskCommand::SaveDraft { control, .. }
        | AgentTaskCommand::Rename { control, .. }
        | AgentTaskCommand::Archive { control, .. }
        | AgentTaskCommand::Connect { control }
        | AgentTaskCommand::Resume { control }
        | AgentTaskCommand::Disconnect { control }
        | AgentTaskCommand::TakeOver { control, .. }
        | AgentTaskCommand::Send { control, .. }
        | AgentTaskCommand::Configure { control, .. }
        | AgentTaskCommand::Stop { control }
        | AgentTaskCommand::Decision { control, .. }
        | AgentTaskCommand::AddAsset { control, .. }
        | AgentTaskCommand::RemoveAsset { control, .. } => Some(control),
    }
}
pub fn agent_busy(state: &str) -> bool {
    matches!(
        state,
        "connecting" | "resuming" | "running" | "waiting_for_permission" | "stopping"
    )
}
pub fn unconfirmed_receipt(receipt: &AgentCommandReceipt) -> bool {
    matches!(receipt.status.as_str(), "uncertain" | "interrupted")
}
fn fresh() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn invalid(message: &str) -> AgentTaskError {
    AgentTaskError::InvalidInput(message.into())
}

impl AgentTaskOwner {
    pub fn new(store: Arc<dyn AgentTaskRepository>) -> Self {
        Self {
            store,
            host_incarnation: fresh(),
            gate: Mutex::new(()),
        }
    }
    pub fn effective(&self, mut task: StoredAgentTask) -> StoredAgentTask {
        if task.host_incarnation != self.host_incarnation {
            task.attachment.state = if task.task.native_session_id.is_some() {
                "disconnected"
            } else if task.active_request.is_some() {
                "uncertain"
            } else {
                "draft"
            }
            .into();
            task.attachment.decisions.clear();
            task.attachment.connection_id = None;
            // An interrupted takeover remains unresolved; a new Host must prove
            // old-process quiet before completing it.
            task.interrupted_context |= task.active_request.is_some();
        }
        task
    }
    pub fn get(&self, scope: &AgentTaskScope, id: &str) -> Result<StoredAgentTask, AgentTaskError> {
        self.store
            .agent_task(scope, id)?
            .map(|t| self.effective(t))
            .ok_or(AgentTaskError::NotFound)
    }
    pub fn detail(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<AgentTaskDetail, AgentTaskError> {
        let task = self.get(scope, id)?;
        let draft = self.store.agent_draft(scope, id)?;
        let mut receipts = self.store.agent_receipts(scope, id)?;
        if task.host_incarnation != self.host_incarnation {
            for r in &mut receipts {
                if matches!(r.status.as_str(), "prepared" | "submitted") {
                    r.status = "uncertain".into();
                    r.error = Some(
                        "Host restarted before the original native outcome was confirmed".into(),
                    );
                }
            }
        }
        let summary = AgentTaskSummary {
            observation_version: task.observation_version,
            history_generation: task.history_generation,
            task: task.task,
            attachment: task.attachment,
            draft_version: draft.version,
            has_draft: !draft.content.text.is_empty()
                || !draft.content.assets.is_empty()
                || !draft.content.context.is_empty(),
            event_cursor: task.event_cursor,
            history_gap: task.history_gap,
            unconfirmed: receipts.iter().filter(|r| unconfirmed_receipt(r)).count(),
        };
        Ok(AgentTaskDetail {
            summary,
            draft,
            receipts,
            assets: self.store.agent_assets(scope, id)?,
        })
    }
    /// Caller/window liveness is checked by the Host before admission. A matching
    /// request returns its persisted receipt without repeating a native action.
    pub fn admit(
        &self,
        scope: &AgentTaskScope,
        request: &AgentTaskRequest,
        now: u64,
    ) -> Result<AgentTaskAdmission, AgentTaskError> {
        self.admit_inner(scope, request, now, None)
    }
    /// The containing backend validates live caller/instance identity before this
    /// admission. Retained origin records support inspection, never later dispatch.
    pub fn admit_native(
        &self,
        scope: &AgentTaskScope,
        request: &AgentTaskRequest,
        origin: AgentNativeCommandOrigin,
        now: u64,
    ) -> Result<AgentTaskAdmission, AgentTaskError> {
        origin.validate(scope)?;
        self.admit_inner(scope, request, now, Some(origin))
    }
    fn admit_inner(
        &self,
        scope: &AgentTaskScope,
        request: &AgentTaskRequest,
        now: u64,
        origin: Option<AgentNativeCommandOrigin>,
    ) -> Result<AgentTaskAdmission, AgentTaskError> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| invalid("Agent metadata lock poisoned"))?;
        uuid::Uuid::parse_str(&request.request_id).map_err(|_| invalid("Invalid request ID"))?;
        if request.project_root != scope.project {
            return Err(AgentTaskError::NotFound);
        }
        let digest = agent_request_digest(request)?;
        if let Some(receipt) = self.store.agent_receipt(scope, &request.request_id)? {
            if receipt.request_digest != digest {
                return Err(AgentTaskError::RequestConflict);
            }
            if let Some(origin) = &origin {
                let original = self
                    .store
                    .agent_native_admission(scope, &request.request_id)?
                    .ok_or(AgentTaskError::RequestConflict)?;
                original.validate(scope, &receipt)?;
                // A new transport request only observes this original admission.
                // It cannot move the command to a different Agent instance.
                if original.origin.binding != origin.binding
                    || original.origin.tools != origin.tools
                {
                    return Err(AgentTaskError::RequestConflict);
                }
            }
            return Ok(AgentTaskAdmission {
                task: self.get(scope, &receipt.task_id)?,
                draft: self.store.agent_draft(scope, &receipt.task_id)?,
                receipt,
                repeated: true,
                native: false,
            });
        }
        let (mut task, mut draft, expected) = if let AgentTaskCommand::Create {
            provider,
            model,
            effort,
        } = &request.command
        {
            if model.is_empty()
                || model.len() > 512
                || effort.as_ref().is_some_and(|e| e.len() > 128)
            {
                return Err(invalid("Select a native model"));
            }
            let task = StoredAgentTask {
                task_mcp_identity: true,
                task: AgentTask {
                    task_id: fresh(),
                    project_root: scope.project.clone(),
                    provider: *provider,
                    native_session_id: None,
                    title: "New task".into(),
                    created_at_ms: now,
                    updated_at_ms: now,
                    archived: false,
                    model: model.clone(),
                    effort: effort.clone(),
                    mode: None,
                },
                attachment: AgentAttachment {
                    generation: 1,
                    controller: request.window.clone(),
                    connection_id: None,
                    state: "draft".into(),
                    capabilities: AgentNativeCapabilities::default(),
                    decisions: vec![],
                    error: None,
                    control_frozen: false,
                },
                revision: fresh(),
                observation_version: 0,
                host_incarnation: self.host_incarnation.clone(),
                process: None,
                active_request: None,
                automatic_title: true,
                event_cursor: 0,
                history_gap: false,
                interrupted_context: false,
                history_generation: 0,
                native_quiet: true,
            };
            (
                task,
                AgentTaskDraft {
                    version: 0,
                    content: AgentDraftContent::default(),
                    updated_at_ms: now,
                },
                None,
            )
        } else {
            let control =
                agent_control(&request.command).ok_or_else(|| invalid("Missing task control"))?;
            let task = self.get(scope, &control.task_id)?;
            if task.attachment.generation != control.generation {
                return Err(AgentTaskError::Conflict);
            }
            if !matches!(request.command, AgentTaskCommand::TakeOver { .. })
                && task.attachment.controller.window_id != request.window.window_id
            {
                return Err(invalid("This task is controlled by another window"));
            }
            if task.attachment.control_frozen
                && !matches!(
                    request.command,
                    AgentTaskCommand::TakeOver { stop: true, .. } | AgentTaskCommand::Stop { .. }
                )
            {
                return Err(invalid(
                    "Task control is waiting for confirmed native quiet",
                ));
            }
            let draft = self.store.agent_draft(scope, &control.task_id)?;
            let expected = task.revision.clone();
            (task, draft, Some(expected))
        };
        if task.task.archived
            && matches!(
                request.command,
                AgentTaskCommand::SaveDraft { .. }
                    | AgentTaskCommand::Send { .. }
                    | AgentTaskCommand::AddAsset { .. }
                    | AgentTaskCommand::RemoveAsset { .. }
                    | AgentTaskCommand::Configure { .. }
                    | AgentTaskCommand::Connect { .. }
                    | AgentTaskCommand::Resume { .. }
            )
        {
            return Err(invalid("Unarchive this task before editing or sending"));
        }
        let native_input = origin.as_ref().map(|_| (task.task.clone(), draft.clone()));
        let mut receipt = AgentCommandReceipt {
            request_id: request.request_id.clone(),
            task_id: task.task.task_id.clone(),
            command: agent_command_name(&request.command).into(),
            input_digest: agent_input_digest(request, &task.task, &draft)?,
            request_digest: digest.clone(),
            input_assets: if matches!(request.command, AgentTaskCommand::Send { .. }) {
                draft.content.assets.clone()
            } else {
                vec![]
            },
            input_context: if matches!(request.command, AgentTaskCommand::Send { .. }) {
                draft.content.context.clone()
            } else {
                vec![]
            },
            submitted_draft: if matches!(request.command, AgentTaskCommand::Send { .. }) {
                Some(draft.content.clone())
            } else {
                None
            },
            status: "succeeded".into(),
            native_session_id: task.task.native_session_id.clone(),
            native_turn_id: None,
            created_at_ms: now,
            updated_at_ms: now,
            error: None,
            submitted_draft_version: None,
        };
        let mut native = false;
        match &request.command {
            AgentTaskCommand::Create { .. } => {}
            AgentTaskCommand::SaveDraft {
                version, content, ..
            } => {
                if *version != draft.version {
                    return Err(AgentTaskError::Conflict);
                }
                if content.text.len() > MAX_AGENT_DRAFT_BYTES
                    || content.assets.len() > 20
                    || content.context.len() > 20
                    || serde_json::to_vec(content)
                        .map_err(|_| invalid("Invalid draft"))?
                        .len()
                        > 256 * 1024
                {
                    return Err(AgentTaskError::Budget("Agent draft is too large".into()));
                }
                let assets = self.store.agent_assets(scope, &task.task.task_id)?;
                if content
                    .assets
                    .iter()
                    .any(|id| !assets.iter().any(|a| a.asset_id == *id))
                {
                    return Err(invalid("An attachment is unavailable to this task"));
                }
                draft = AgentTaskDraft {
                    version: draft.version + 1,
                    content: content.clone(),
                    updated_at_ms: now,
                };
            }
            AgentTaskCommand::Rename { title, .. } => {
                if title.trim().is_empty() || title.len() > 240 {
                    return Err(invalid("Task title must contain 1–240 bytes"));
                }
                task.task.title = title.trim().into();
                task.automatic_title = false;
            }
            AgentTaskCommand::Archive { archived, .. } => task.task.archived = *archived,
            AgentTaskCommand::TakeOver { stop, .. } => {
                if !*stop
                    && (agent_busy(&task.attachment.state)
                        || !task.attachment.decisions.is_empty()
                        || task.active_request.is_some()
                        || task.attachment.control_frozen)
                {
                    return Err(invalid("Stop the Agent before taking over this task"));
                }
                if *stop {
                    task.attachment.control_frozen = true;
                    task.attachment.state = "stopping".into();
                    native = true;
                } else {
                    task.attachment.generation += 1;
                    task.attachment.controller = request.window.clone();
                }
            }
            AgentTaskCommand::Send { draft_version, .. } => {
                if *draft_version != draft.version {
                    return Err(AgentTaskError::Conflict);
                }
                if draft.content.text.trim().is_empty()
                    && draft.content.assets.is_empty()
                    && draft.content.context.is_empty()
                {
                    return Err(invalid("Write a message or add context"));
                }
                if task.active_request.is_some()
                    || agent_busy(&task.attachment.state)
                    || matches!(task.attachment.state.as_str(), "uncertain" | "disconnected")
                {
                    return Err(invalid("Resume or resolve the current turn before sending"));
                }
                if task.automatic_title {
                    task.task.title = draft.content.text.trim().chars().take(64).collect();
                    if task.task.title.is_empty() {
                        task.task.title = "Attached context".into();
                    }
                    task.automatic_title = false;
                }
                task.active_request = Some(request.request_id.clone());
                receipt.submitted_draft_version = Some(draft.version);
                if task.task.native_session_id.is_none() {
                    task.attachment.generation += 1;
                    task.attachment.state = "connecting".into();
                } else {
                    task.attachment.state = "running".into();
                }
                native = true;
            }
            AgentTaskCommand::Connect { .. } | AgentTaskCommand::Resume { .. } => {
                if agent_busy(&task.attachment.state) {
                    return Err(invalid("Agent is busy"));
                }
                if matches!(request.command, AgentTaskCommand::Connect { .. })
                    && task.task.native_session_id.is_some()
                {
                    return Err(invalid("Use Resume for this task's native session"));
                }
                if matches!(request.command, AgentTaskCommand::Resume { .. })
                    && task.task.native_session_id.is_none()
                {
                    return Err(invalid("No confirmed native session can be resumed"));
                }
                if task.task.native_session_id.is_none() && task.active_request.is_some() {
                    return Err(invalid(
                        "Native session creation is unconfirmed; inspect the original receipt",
                    ));
                }
                task.attachment.generation += 1;
                task.attachment.state = if task.task.native_session_id.is_some() {
                    "resuming"
                } else {
                    "connecting"
                }
                .into();
                native = true;
            }
            AgentTaskCommand::Configure {
                model,
                effort,
                mode,
                ..
            } => {
                if model.is_empty()
                    || model.len() > 512
                    || effort.as_ref().is_some_and(|e| e.len() > 128)
                    || mode.as_ref().is_some_and(|m| m.len() > 128)
                {
                    return Err(invalid("Invalid native configuration"));
                }
                task.task.model = model.clone();
                task.task.effort = effort.clone();
                task.task.mode = mode.clone();
                native = task.attachment.connection_id.is_some();
            }
            AgentTaskCommand::Disconnect { .. } => {
                if agent_busy(&task.attachment.state) || !task.attachment.decisions.is_empty() {
                    return Err(invalid("Stop the Agent before disconnecting"));
                }
                native = true;
            }
            AgentTaskCommand::Stop { .. } => {
                task.attachment.state = "stopping".into();
                native = true;
            }
            AgentTaskCommand::Decision {
                decision_id,
                option_id,
                ..
            } => {
                if !task
                    .attachment
                    .decisions
                    .iter()
                    .any(|d| d.id == *decision_id && d.options.iter().any(|o| o.id == *option_id))
                {
                    return Err(invalid("This native permission is no longer pending"));
                }
                native = true;
            }
            AgentTaskCommand::AddAsset { .. } | AgentTaskCommand::RemoveAsset { .. } => {
                native = true
            }
        }
        if native {
            receipt.status = "prepared".into();
            if matches!(
                request.command,
                AgentTaskCommand::Connect { .. }
                    | AgentTaskCommand::Resume { .. }
                    | AgentTaskCommand::Send { .. }
            ) {
                task.host_incarnation = self.host_incarnation.clone();
                if task.task.native_session_id.is_none() {
                    task.active_request = Some(request.request_id.clone());
                }
            }
        }
        task.revision = fresh();
        task.observation_version += 1;
        task.task.updated_at_ms = now;
        // A live window re-registration may renew its incarnation without becoming
        // a different operating window. Host liveness validates the new reference.
        if task.attachment.controller.window_id == request.window.window_id {
            task.attachment.controller = request.window.clone();
        }
        let write = AgentTaskWrite {
            expected_revision: expected.as_deref(),
            task: &task,
            draft: Some(&draft),
            receipts: std::slice::from_ref(&receipt),
            events: &[],
        };
        if let Some(origin) = origin {
            let (input_task, input_draft) = native_input.unwrap();
            let capture = StoredAgentNativeAdmission {
                input_task,
                input_draft,
                task_id: task.task.task_id.clone(),
                request_digest: digest,
                request: request.clone(),
                origin,
            };
            capture.validate(scope, &receipt)?;
            self.store
                .commit_agent_native_admission(scope, write, &capture)?;
        } else {
            self.store.commit_agent_task(scope, write)?;
        }
        Ok(AgentTaskAdmission {
            task,
            receipt,
            draft,
            repeated: false,
            native,
        })
    }
    pub fn update(
        &self,
        scope: &AgentTaskScope,
        id: &str,
        generation: u64,
        change: impl FnOnce(
            &mut StoredAgentTask,
            &mut AgentTaskDraft,
            &mut Vec<AgentCommandReceipt>,
            &mut Vec<AgentTaskEvent>,
        ) -> Result<(), AgentTaskError>,
    ) -> Result<(), AgentTaskError> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| invalid("Agent metadata lock poisoned"))?;
        let mut task = self.get(scope, id)?;
        if task.attachment.generation != generation {
            return Err(AgentTaskError::Conflict);
        }
        let revision = task.revision.clone();
        let mut draft = self.store.agent_draft(scope, id)?;
        let mut receipts = vec![];
        let mut events = vec![];
        change(&mut task, &mut draft, &mut receipts, &mut events)?;
        task.revision = fresh();
        task.observation_version += 1;
        self.store.commit_agent_task(
            scope,
            AgentTaskWrite {
                expected_revision: Some(&revision),
                task: &task,
                draft: Some(&draft),
                receipts: &receipts,
                events: &events,
            },
        )
    }
}

#[cfg(test)]
mod tests;

mod model;
pub use model::{ComponentModelKey, validate_model_connection};

pub mod component;
pub mod handoff;
