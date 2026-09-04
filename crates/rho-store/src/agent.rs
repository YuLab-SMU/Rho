use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConversationDraft {
    pub conversation_id: String,
    pub project_root: String,
    pub title: String,
    pub legacy_unthreaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct AgentConversationSummary {
    pub conversation_id: String,
    pub project_root: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub legacy_unthreaded: bool,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub turn_count: i64,
    pub status: String,
    pub latest_turn_id: Option<String>,
    pub latest_prompt_preview: Option<String>,
    pub terminal_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnDraft {
    pub turn_id: String,
    pub project_root: String,
    pub prompt: String,
    pub model: String,
    pub workspace_id: String,
    pub state_revision_before: i64,
    pub project_revision_before: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnFinish {
    pub turn_id: String,
    pub status: String,
    pub terminal_reason: Option<String>,
    pub workspace_id_after: Option<String>,
    pub state_revision_after: Option<i64>,
    pub project_revision_after: Option<i64>,
    pub final_message: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnSummary {
    pub turn_id: String,
    pub conversation_id: String,
    pub project_root: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub prompt_preview: String,
    pub model: String,
    pub workspace_id_before: Option<String>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub state_revision_before: Option<i64>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub project_revision_before: Option<i64>,
    pub workspace_id_after: Option<String>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub state_revision_after: Option<i64>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub project_revision_after: Option<i64>,
    pub final_message: Option<String>,
    pub error_message: Option<String>,
    pub retry_of_turn_id: Option<String>,
    pub terminal_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentConversationTurn {
    pub turn_id: String,
    pub status: String,
    pub prompt: String,
    pub final_message: Option<String>,
    pub error_message: Option<String>,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnEventDraft {
    pub turn_id: String,
    pub event_type: String,
    pub title: String,
    pub body: Option<String>,
    pub status: String,
    pub tool: Option<String>,
    pub request_id: Option<String>,
    pub code: Option<String>,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnEvent {
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub id: i64,
    pub turn_id: String,
    pub timestamp: String,
    pub event_type: String,
    pub title: String,
    pub body: Option<String>,
    pub status: String,
    pub tool: Option<String>,
    pub request_id: Option<String>,
    pub code: Option<String>,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnDetail {
    pub turn: AgentTurnSummary,
    pub events: Vec<AgentTurnEvent>,
}

pub(crate) fn decode_agent_turn_summary(row: &Row<'_>) -> rusqlite::Result<AgentTurnSummary> {
    Ok(AgentTurnSummary {
        turn_id: row.get(0)?,
        conversation_id: row.get(1)?,
        project_root: row.get(2)?,
        status: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        prompt_preview: row.get(6)?,
        model: row.get(7)?,
        workspace_id_before: row.get(8)?,
        state_revision_before: row.get(9)?,
        project_revision_before: row.get(10)?,
        workspace_id_after: row.get(11)?,
        state_revision_after: row.get(12)?,
        project_revision_after: row.get(13)?,
        final_message: row.get(14)?,
        error_message: row.get(15)?,
        retry_of_turn_id: row.get(16)?,
        terminal_reason: row.get(17)?,
    })
}

pub(crate) fn decode_agent_turn_event(row: &Row<'_>) -> rusqlite::Result<AgentTurnEvent> {
    Ok(AgentTurnEvent {
        id: row.get(0)?,
        turn_id: row.get(1)?,
        timestamp: row.get(2)?,
        event_type: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        status: row.get(6)?,
        tool: row.get(7)?,
        request_id: row.get(8)?,
        code: row.get(9)?,
        details_json: row.get(10)?,
    })
}

/// Live projection of one durable Agent turn mutation for UI subscribers.
///
/// Frames are notifications, never the source of truth. Every mutable text
/// field is byte-bounded and the complete serialized frame is constrained to
/// a small budget. A subscriber that sees `payload_truncated` must refetch the
/// canonical turn detail.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnUpdateFrame {
    pub status: String,
    pub final_message: Option<String>,
    pub error_message: Option<String>,
    pub terminal_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnEventFrame {
    pub project_root: String,
    pub turn_id: String,
    pub event: Option<AgentTurnEvent>,
    pub turn_update: Option<AgentTurnUpdateFrame>,
    pub payload_truncated: bool,
}

pub(crate) const AGENT_TURN_FRAME_MAX_BYTES: usize = 32 * 1024;
// 2 KiB per identity leaves enough room below the 32 KiB total budget even
// when JSON escaping expands every byte into a six-byte escape sequence.
const AGENT_TURN_FRAME_ID_MAX_BYTES: usize = 2 * 1024;
const AGENT_TURN_FRAME_FIELD_MAX_BYTES: usize = 4 * 1024;

fn bound_frame_text(value: String, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn bound_optional_frame_text(value: Option<String>, max_bytes: usize) -> (Option<String>, bool) {
    match value {
        Some(value) => {
            let (value, truncated) = bound_frame_text(value, max_bytes);
            (Some(value), truncated)
        }
        None => (None, false),
    }
}

impl AgentTurnEventFrame {
    pub fn from_event(project_root: String, event: AgentTurnEvent) -> Self {
        let (project_root, root_truncated) =
            bound_frame_text(project_root, AGENT_TURN_FRAME_ID_MAX_BYTES);
        let (turn_id, turn_id_truncated) =
            bound_frame_text(event.turn_id.clone(), AGENT_TURN_FRAME_ID_MAX_BYTES);
        let (event_turn_id, event_turn_id_truncated) =
            bound_frame_text(event.turn_id, AGENT_TURN_FRAME_ID_MAX_BYTES);
        let (timestamp, timestamp_truncated) =
            bound_frame_text(event.timestamp, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (event_type, event_type_truncated) =
            bound_frame_text(event.event_type, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (title, title_truncated) =
            bound_frame_text(event.title, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (body, body_truncated) =
            bound_optional_frame_text(event.body, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (status, status_truncated) =
            bound_frame_text(event.status, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (tool, tool_truncated) =
            bound_optional_frame_text(event.tool, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (request_id, request_id_truncated) =
            bound_optional_frame_text(event.request_id, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (code, code_truncated) =
            bound_optional_frame_text(event.code, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (details_json, details_truncated) =
            bound_frame_text(event.details_json, AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let payload_truncated = root_truncated
            || turn_id_truncated
            || event_turn_id_truncated
            || timestamp_truncated
            || event_type_truncated
            || title_truncated
            || body_truncated
            || status_truncated
            || tool_truncated
            || request_id_truncated
            || code_truncated
            || details_truncated;
        Self {
            project_root,
            turn_id,
            event: Some(AgentTurnEvent {
                id: event.id,
                turn_id: event_turn_id,
                timestamp,
                event_type,
                title,
                body,
                status,
                tool,
                request_id,
                code,
                details_json,
            }),
            turn_update: None,
            payload_truncated,
        }
        .within_budget()
    }

    pub fn from_finish(project_root: String, finish: &AgentTurnFinish) -> Self {
        let (project_root, root_truncated) =
            bound_frame_text(project_root, AGENT_TURN_FRAME_ID_MAX_BYTES);
        let (turn_id, turn_id_truncated) =
            bound_frame_text(finish.turn_id.clone(), AGENT_TURN_FRAME_ID_MAX_BYTES);
        let (status, status_truncated) =
            bound_frame_text(finish.status.clone(), AGENT_TURN_FRAME_FIELD_MAX_BYTES);
        let (final_message, final_truncated) = bound_optional_frame_text(
            finish.final_message.clone(),
            AGENT_TURN_FRAME_FIELD_MAX_BYTES,
        );
        let (error_message, error_truncated) = bound_optional_frame_text(
            finish.error_message.clone(),
            AGENT_TURN_FRAME_FIELD_MAX_BYTES,
        );
        let (terminal_reason, terminal_truncated) = bound_optional_frame_text(
            finish.terminal_reason.clone(),
            AGENT_TURN_FRAME_FIELD_MAX_BYTES,
        );
        Self {
            project_root,
            turn_id,
            event: None,
            turn_update: Some(AgentTurnUpdateFrame {
                status,
                final_message,
                error_message,
                terminal_reason,
            }),
            payload_truncated: root_truncated
                || turn_id_truncated
                || status_truncated
                || final_truncated
                || error_truncated
                || terminal_truncated,
        }
        .within_budget()
    }

    fn within_budget(mut self) -> Self {
        let over_budget = serde_json::to_vec(&self)
            .map(|serialized| serialized.len() > AGENT_TURN_FRAME_MAX_BYTES)
            .unwrap_or(true);
        if over_budget {
            self.event = None;
            self.turn_update = None;
            self.payload_truncated = true;
        }
        self
    }
}
