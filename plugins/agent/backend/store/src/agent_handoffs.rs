//! Atomic handoff receipt plus a write to an existing native/Rho draft owner.
use crate::AgentStore;
use rho_agent_api::component::*;
use rho_agent_api::handoff::*;
use rho_agent_api::*;
use rho_agent_owner::AgentTaskScope as ApplicationScope;
use rho_agent_owner::component::ComponentTaskError as ApplicationError;
use rho_agent_owner::component::*;
use rho_agent_owner::handoff::*;
use rho_agent_owner::*;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use std::collections::BTreeSet;

fn error(e: impl std::fmt::Display) -> ApplicationError {
    ApplicationError::Storage(e.to_string())
}
fn decode<T: DeserializeOwned>(value: String) -> Result<T, ApplicationError> {
    serde_json::from_str(&value).map_err(error)
}
fn encode(value: &impl Serialize) -> Result<String, ApplicationError> {
    serde_json::to_string(value).map_err(error)
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_handoff_receipts(
        project TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,request_id));",
        )
        .map_err(|e| e.to_string())
}

fn native(
    connection: &Connection,
    scope: &ApplicationScope,
    id: &str,
) -> Result<StoredAgentTask, ApplicationError> {
    let row: Option<String> = connection
        .query_row(
            "SELECT value FROM agent_tasks WHERE project=?1 AND principal=?2 AND task_id=?3",
            params![scope.project, scope.principal, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error)?;
    decode(row.ok_or(ApplicationError::NotFound)?)
}
fn native_draft(
    connection: &Connection,
    scope: &ApplicationScope,
    id: &str,
) -> Result<AgentTaskDraft, ApplicationError> {
    let row: Option<String> = connection
        .query_row(
            "SELECT value FROM agent_task_drafts WHERE project=?1 AND principal=?2 AND task_id=?3",
            params![scope.project, scope.principal, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error)?;
    decode(row.ok_or(ApplicationError::NotFound)?)
}
fn rho(
    connection: &Connection,
    scope: &ApplicationScope,
    id: &str,
) -> Result<ComponentAgentConversation, ApplicationError> {
    let row:Option<String>=connection.query_row("SELECT value FROM component_agent_conversations WHERE project=?1 AND principal=?2 AND conversation_id=?3",
        params![scope.project,scope.principal,id],|row|row.get(0)).optional().map_err(error)?;
    decode(row.ok_or(ApplicationError::NotFound)?)
}
fn rho_draft(conversation: &ComponentAgentConversation) -> AgentDraftContent {
    let mut draft = conversation.draft_content.clone();
    if draft.text.is_empty() && !conversation.draft.is_empty() {
        draft.text = conversation.draft.clone();
    }
    draft
}
fn receipt(
    connection: &Connection,
    scope: &ApplicationScope,
    id: &str,
) -> Result<Option<StoredAgentHandoff>, ApplicationError> {
    let row:Option<String>=connection.query_row("SELECT value FROM agent_handoff_receipts WHERE project=?1 AND principal=?2 AND request_id=?3",
        params![scope.project,scope.principal,id],|row|row.get(0)).optional().map_err(error)?;
    row.map(decode).transpose()
}
fn target(
    connection: &Connection,
    scope: &ApplicationScope,
    reference: &ProjectAgentTaskRef,
    window: &ApplicationWindowRef,
) -> Result<AgentHandoffTargetSnapshot, ApplicationError> {
    let (title, draft, draft_version, controller, control_generation, reason) = match reference {
        ProjectAgentTaskRef::Native { task_id } => {
            let task = native(connection, scope, task_id)?;
            let draft = native_draft(connection, scope, task_id)?;
            let reason = if task.task.archived {
                Some("Unarchive this task before changing its draft")
            } else if task.attachment.control_frozen {
                Some("Task control is waiting for confirmed native quiet")
            } else if task.attachment.controller.window_id != window.window_id {
                Some("This task is controlled by another window")
            } else {
                None
            };
            (
                task.task.title,
                draft.content,
                draft.version,
                task.attachment.controller,
                Some(task.attachment.generation),
                reason,
            )
        }
        ProjectAgentTaskRef::Rho { conversation_id } => {
            let conversation = rho(connection, scope, conversation_id)?;
            let draft = rho_draft(&conversation);
            let reason = if conversation.archived {
                Some("Unarchive this task before changing its draft")
            } else if conversation.controller != *window {
                Some("This task is controlled by another window")
            } else {
                None
            };
            (
                conversation.title,
                draft,
                conversation.draft_version,
                conversation.controller,
                None,
                reason,
            )
        }
    };
    Ok(AgentHandoffTargetSnapshot {
        target: reference.clone(),
        title,
        draft,
        draft_version,
        controller,
        control_generation,
        writable: reason.is_none(),
        reason: reason.map(str::to_owned),
    })
}

struct SourceContext {
    items: Vec<AgentContextSelection>,
    seen: BTreeSet<String>,
    bytes: usize,
    truncated: bool,
    attachments: bool,
}
impl SourceContext {
    fn new() -> Self {
        Self {
            items: vec![],
            seen: BTreeSet::new(),
            bytes: 0,
            truncated: false,
            attachments: false,
        }
    }
    fn add(&mut self, selection: AgentContextSelection) -> Result<(), ApplicationError> {
        if selection.source == "attachments" {
            self.attachments = true;
            return Ok(());
        }
        let key = handoff_context_key(&selection)?;
        if self.seen.contains(&key) {
            return Ok(());
        }
        let bytes = encode(&selection)?.len();
        if self.items.len() >= MAX_HANDOFF_CONTEXT || bytes > 4096 || self.bytes + bytes > 16 * 1024
        {
            self.truncated = true;
            return Ok(());
        }
        self.seen.insert(key);
        self.bytes += bytes;
        self.items.push(selection);
        Ok(())
    }
    fn evidence(&mut self, evidence: ComponentAgentEvidence) -> Result<(), ApplicationError> {
        match evidence {
            ComponentAgentEvidence::Operation { operation_id } => self.add(AgentContextSelection {
                source: "operations".into(),
                label: "Original operation".into(),
                reference: json!({"operation_id":operation_id}),
                inclusion: "summary".into(),
            }),
            ComponentAgentEvidence::Media { reference } => self.add(AgentContextSelection {
                source: "plots".into(),
                label: "Original plot".into(),
                reference: serde_json::to_value(reference).map_err(error)?,
                inclusion: "summary".into(),
            }),
            ComponentAgentEvidence::File { path, sha256 } => self.add(AgentContextSelection {
                source: "files".into(),
                label: path.clone(),
                reference: json!({"path":path,"expected_sha256":sha256}),
                inclusion: "text".into(),
            }),
            ComponentAgentEvidence::Attachment { .. } => {
                self.attachments = true;
                Ok(())
            }
            // Document evidence requires its actual acknowledged hash/selection;
            // it is added from applied_document_summaries below, never fabricated.
            ComponentAgentEvidence::Document { .. }
            | ComponentAgentEvidence::Observation { .. } => Ok(()),
        }
    }
}
fn clip(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.into(), false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].into(), true)
}
fn source(
    connection: &Connection,
    scope: &ApplicationScope,
    reference: &ProjectAgentTaskRef,
) -> Result<AgentHandoffSourceSnapshot, ApplicationError> {
    let mut contexts = SourceContext::new();
    let mut goal: String;
    let mut user_history_gap = false;
    let title = match reference {
        ProjectAgentTaskRef::Native { task_id } => {
            let task = native(connection, scope, task_id)?;
            let draft = native_draft(connection, scope, task_id)?;
            goal = draft.content.text;
            contexts.attachments = !draft.content.assets.is_empty();
            for selection in draft.content.context {
                contexts.add(selection)?;
            }
            let mut query=connection.prepare("SELECT json_extract(value,'$.submitted_draft.text'),json_extract(value,'$.input_context'),json_extract(value,'$.input_assets') FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND task_id=?3 ORDER BY updated_at DESC,request_id DESC LIMIT 9").map_err(error)?;
            let rows = query
                .query_map(params![scope.project, scope.principal, task_id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?;
            contexts.truncated |= rows.len() > 8;
            for (text, selections, assets) in rows.into_iter().take(8) {
                if goal.trim().is_empty() {
                    goal = text.unwrap_or_default();
                }
                if let Some(selections) = selections {
                    for selection in decode::<Vec<AgentContextSelection>>(selections)? {
                        contexts.add(selection)?;
                    }
                }
                contexts.attachments |=
                    assets.is_some_and(|assets| assets != "[]" && assets != "null");
            }
            if goal.trim().is_empty() {
                // Successful Send clears the draft and recovery copy. The
                // retained native user message remains the source of its goal;
                // assistant text is never promoted into Confirmed material.
                goal = connection.query_row(
                    "SELECT json_extract(value,'$.text') FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3 AND json_extract(value,'$.role')='user' AND length(trim(json_extract(value,'$.text')))>0 ORDER BY sequence DESC LIMIT 1",
                    params![scope.project,scope.principal,task_id],|row|row.get::<_,String>(0)
                ).optional().map_err(error)?.unwrap_or_default();
                user_history_gap = task.history_gap || connection.query_row(
                    "SELECT history_gap FROM agent_tasks WHERE project=?1 AND principal=?2 AND task_id=?3",
                    params![scope.project,scope.principal,task_id],|row|row.get::<_,bool>(0)
                ).map_err(error)?;
                contexts.truncated |= user_history_gap;
            }
            task.task.title
        }
        ProjectAgentTaskRef::Rho { conversation_id } => {
            let conversation = rho(connection, scope, conversation_id)?;
            let draft = rho_draft(&conversation);
            goal = draft.text;
            contexts.attachments = !draft.assets.is_empty();
            for selection in draft.context {
                contexts.add(selection)?;
            }
            let mut query=connection.prepare("SELECT run_id,json_extract(value,'$.run.request.text'),json_extract(value,'$.run.request.assets'),json_extract(value,'$.run.request.window') FROM component_agent_runs WHERE project=?1 AND principal=?2 AND conversation_id=?3 ORDER BY json_extract(value,'$.run.created_at_ms') DESC,run_id DESC LIMIT 5").map_err(error)?;
            let runs = query
                .query_map(
                    params![scope.project, scope.principal, conversation_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?;
            contexts.truncated |= runs.len() > 4;
            for (run, text, assets, window) in runs.into_iter().take(4) {
                if goal.is_empty() {
                    goal = text;
                }
                contexts.attachments |=
                    assets.is_some_and(|assets| assets != "[]" && assets != "null");
                let window: ApplicationWindowRef = decode(window)?;
                let mut query=connection.prepare("SELECT json_extract(s.value,'$.selection') FROM component_agent_runs r,json_each(r.value,'$.run.context.sources') s WHERE r.project=?1 AND r.principal=?2 AND r.run_id=?3 LIMIT 17").map_err(error)?;
                for row in query
                    .query_map(params![scope.project, scope.principal, run], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(error)?
                {
                    contexts.add(decode(row.map_err(error)?)?)?;
                }
                let mut query=connection.prepare("SELECT json_extract(value,'$.receipt.evidence'),json_extract(value,'$.receipt.operation_id'),json_extract(value,'$.receipt.result.applied_document_summaries') FROM component_agent_tools WHERE project=?1 AND principal=?2 AND run_id=?3 ORDER BY model_call,receipt_id LIMIT 17").map_err(error)?;
                for row in query
                    .query_map(params![scope.project, scope.principal, run], |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(error)?
                {
                    let (evidence, operation, documents) = row.map_err(error)?;
                    if let Some(id) = operation {
                        contexts.evidence(ComponentAgentEvidence::Operation {
                            operation_id: OperationId::new(id).map_err(error)?,
                        })?;
                    }
                    if let Some(evidence) = evidence {
                        for evidence in decode::<Vec<ComponentAgentEvidence>>(evidence)? {
                            contexts.evidence(evidence)?;
                        }
                    }
                    if let Some(documents) = documents {
                        for document in decode::<Vec<ApplicationDocumentSummary>>(documents)? {
                            contexts.add(AgentContextSelection{source:"editor".into(),label:document.path.clone().unwrap_or_else(||"Document".into()),
                            reference:json!({"window":window,"document":document.document,"expected_sha256":document.sha256,"selection":document.selection}),inclusion:"text".into()})?;
                        }
                    }
                }
            }
            conversation.title
        }
    };
    let (goal, clipped) = clip(&goal, 8192);
    contexts.truncated |= clipped;
    let mut notices = Vec::new();
    if contexts.attachments {
        notices.push("Uploaded attachments stay in the source task. Add any needed files to the target task separately.".into());
    }
    if user_history_gap {
        notices.push(
            "Native message history is incomplete; Goal uses the latest retained user message."
                .into(),
        );
    }
    if contexts.truncated {
        notices
            .push("Some older text or references are outside this bounded source preview.".into());
    }
    let mut material = AgentHandoffSourceSnapshot {
        source: reference.clone(),
        title,
        body: format!("Goal:\n{goal}\n\nConfirmed:\n\nNext:\n"),
        context: contexts.items,
        revision: String::new(),
        truncated: contexts.truncated,
        notices,
    };
    material.revision = handoff_source_fingerprint(&material)?;
    Ok(material)
}

impl AgentHandoffRepository for AgentStore {
    fn handoff_source(
        &self,
        scope: &ApplicationScope,
        reference: &ProjectAgentTaskRef,
    ) -> Result<AgentHandoffSourceSnapshot, ApplicationError> {
        let connection = self.0.lock().map_err(error)?;
        source(&connection, scope, reference)
    }
    fn handoff_target(
        &self,
        scope: &ApplicationScope,
        reference: &ProjectAgentTaskRef,
        window: &ApplicationWindowRef,
    ) -> Result<AgentHandoffTargetSnapshot, ApplicationError> {
        let connection = self.0.lock().map_err(error)?;
        target(&connection, scope, reference, window)
    }
    fn handoff_receipt(
        &self,
        scope: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredAgentHandoff>, ApplicationError> {
        let connection = self.0.lock().map_err(error)?;
        receipt(&connection, scope, id)
    }
    fn commit_handoff(
        &self,
        scope: &ApplicationScope,
        write: AgentHandoffWrite<'_>,
    ) -> Result<AgentHandoffReceipt, ApplicationError> {
        let mut connection = self.0.lock().map_err(error)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let request = write.request;
        if request.project_root != scope.project
            || request.source == request.target
            || write.receipt.request_id != request.request_id
            || write.receipt.source != request.source
            || write.receipt.target != request.target
            || write.receipt.target_draft_version
                != request
                    .target_draft_version
                    .checked_add(1)
                    .ok_or(ApplicationError::Conflict)?
            || component_digest(request)? != write.input_digest
        {
            return Err(ApplicationError::Conflict);
        }
        if let Some(previous) = receipt(&tx, scope, &request.request_id)? {
            if previous.input_digest != write.input_digest {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok(previous.receipt);
        }
        if source(&tx, scope, &request.source)?.revision != write.source_fingerprint {
            return Err(handoff_source_expired());
        }
        let current = target(&tx, scope, &request.target, &request.window)?;
        if !current.writable
            || current.draft_version != request.target_draft_version
            || current.control_generation != request.target_control_generation
        {
            return Err(ApplicationError::Conflict);
        }
        let count: usize = tx
            .query_row(
                "SELECT COUNT(*) FROM agent_handoff_receipts WHERE project=?1 AND principal=?2",
                params![scope.project, scope.principal],
                |row| row.get(0),
            )
            .map_err(error)?;
        if count >= 4096 {
            return Err(ApplicationError::Budget(
                "The project handoff receipt limit is reached".into(),
            ));
        }
        match &request.target {
            ProjectAgentTaskRef::Native { task_id } => {
                let mut task = native(&tx, scope, task_id)?;
                task.revision = uuid::Uuid::new_v4().to_string();
                task.observation_version = task
                    .observation_version
                    .checked_add(1)
                    .ok_or(ApplicationError::Conflict)?;
                task.task.updated_at_ms = write.receipt.created_at_ms;
                task.attachment.controller = request.window.clone();
                let draft = AgentTaskDraft {
                    version: write.receipt.target_draft_version,
                    content: write.draft.clone(),
                    updated_at_ms: write.receipt.created_at_ms,
                };
                tx.execute("UPDATE agent_tasks SET revision=?4,updated_at=?5,value=?6 WHERE project=?1 AND principal=?2 AND task_id=?3",
                    params![scope.project,scope.principal,task_id,task.revision,task.task.updated_at_ms,encode(&task)?]).map_err(error)?;
                tx.execute("UPDATE agent_task_drafts SET version=?4,value=?5 WHERE project=?1 AND principal=?2 AND task_id=?3",
                    params![scope.project,scope.principal,task_id,draft.version,encode(&draft)?]).map_err(error)?;
            }
            ProjectAgentTaskRef::Rho { conversation_id } => {
                let before =
                    crate::component_agents::payload_budget::charged_bytes(&tx, &scope.project)?;
                let mut conversation = rho(&tx, scope, conversation_id)?;
                conversation.version = conversation
                    .version
                    .checked_add(1)
                    .ok_or(ApplicationError::Conflict)?;
                conversation.draft_version = write.receipt.target_draft_version;
                conversation.draft = write.draft.text.clone();
                conversation.draft_content = write.draft.clone();
                conversation.updated_at_ms = write.receipt.created_at_ms;
                let value = encode(&conversation)?;
                if value.len() > MAX_COMPONENT_CONVERSATION_RECORD_BYTES {
                    return Err(ApplicationError::Budget(
                        "Conversation payload is too large".into(),
                    ));
                }
                tx.execute("UPDATE component_agent_conversations SET version=?4,updated_at=?5,value=?6 WHERE project=?1 AND principal=?2 AND conversation_id=?3",
                    params![scope.project,scope.principal,conversation_id,conversation.version,conversation.updated_at_ms,value]).map_err(error)?;
                crate::component_agents::payload_budget::enforce(&tx, &scope.project, before)?;
            }
        }
        let saved = StoredAgentHandoff {
            input_digest: write.input_digest.into(),
            receipt: write.receipt.clone(),
        };
        tx.execute("INSERT INTO agent_handoff_receipts(project,principal,request_id,value) VALUES(?1,?2,?3,?4)",
            params![scope.project,scope.principal,request.request_id,encode(&saved)?]).map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(write.receipt.clone())
    }
}
