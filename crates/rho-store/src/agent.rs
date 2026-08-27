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
    pub latest_mode: Option<String>,
    pub latest_prompt_preview: Option<String>,
    pub terminal_reason: Option<String>,
    pub pending_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnDraft {
    pub turn_id: String,
    pub project_root: String,
    pub mode: String,
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
    pub mode: String,
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
    pub pending_request_id: Option<String>,
    pub retry_of_turn_id: Option<String>,
    pub terminal_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentConversationTurn {
    pub turn_id: String,
    pub mode: String,
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
pub struct ApprovalRequestDraft {
    pub request_id: String,
    pub turn_id: String,
    pub project_root: String,
    pub tool: String,
    pub policy: String,
    pub arguments_json: String,
    pub code: Option<String>,
    pub workspace_id: String,
    pub state_revision: i64,
    pub project_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecisionRecord {
    pub decision: String,
    pub status: String,
    pub reason: Option<String>,
    pub continuation_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ApprovalRequestSummary {
    pub request_id: String,
    pub turn_id: String,
    pub project_root: String,
    pub tool: String,
    pub policy: String,
    pub status: String,
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub arguments_json: String,
    pub code: Option<String>,
    pub workspace_id: Option<String>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub state_revision: Option<i64>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub project_revision: Option<i64>,
    pub requested_at: String,
    pub responded_at: Option<String>,
    pub continuation_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnDetail {
    pub turn: AgentTurnSummary,
    pub events: Vec<AgentTurnEvent>,
    pub approvals: Vec<ApprovalRequestSummary>,
}

pub(crate) fn decode_agent_turn_summary(row: &Row<'_>) -> rusqlite::Result<AgentTurnSummary> {
    Ok(AgentTurnSummary {
        turn_id: row.get(0)?,
        conversation_id: row.get(1)?,
        project_root: row.get(2)?,
        mode: row.get(3)?,
        status: row.get(4)?,
        started_at: row.get(5)?,
        finished_at: row.get(6)?,
        prompt_preview: row.get(7)?,
        model: row.get(8)?,
        workspace_id_before: row.get(9)?,
        state_revision_before: row.get(10)?,
        project_revision_before: row.get(11)?,
        workspace_id_after: row.get(12)?,
        state_revision_after: row.get(13)?,
        project_revision_after: row.get(14)?,
        final_message: row.get(15)?,
        error_message: row.get(16)?,
        pending_request_id: row.get(17)?,
        retry_of_turn_id: row.get(18)?,
        terminal_reason: row.get(19)?,
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

pub(crate) fn decode_approval_request(row: &Row<'_>) -> rusqlite::Result<ApprovalRequestSummary> {
    Ok(ApprovalRequestSummary {
        request_id: row.get(0)?,
        turn_id: row.get(1)?,
        project_root: row.get(2)?,
        tool: row.get(3)?,
        policy: row.get(4)?,
        status: row.get(5)?,
        decision: row.get(6)?,
        reason: row.get(7)?,
        arguments_json: row.get(8)?,
        code: row.get(9)?,
        workspace_id: row.get(10)?,
        state_revision: row.get(11)?,
        project_revision: row.get(12)?,
        requested_at: row.get(13)?,
        responded_at: row.get(14)?,
        continuation_outcome: row.get(15)?,
    })
}

/// Live projection of one Agent turn mutation for UI subscribers.
///
/// Frames are emitted after the corresponding durable append/finish succeeds;
/// they are a replayable notification layer, never the source of truth. Text
/// payloads are byte-bounded at emission time and flagged when truncated so
/// subscribers can refetch the canonical record via the detail query.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnUpdateFrame {
    pub status: String,
    pub final_message: Option<String>,
    pub error_message: Option<String>,
    pub terminal_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnEventFrame {
    pub turn_id: String,
    pub event: Option<AgentTurnEvent>,
    pub turn_update: Option<AgentTurnUpdateFrame>,
    pub payload_truncated: bool,
}

pub(crate) const AGENT_TURN_FRAME_FIELD_MAX_BYTES: usize = 4096;

pub(crate) fn bound_frame_field(value: Option<String>) -> (Option<String>, bool) {
    match value {
        Some(text) if text.len() > AGENT_TURN_FRAME_FIELD_MAX_BYTES => {
            let mut end = AGENT_TURN_FRAME_FIELD_MAX_BYTES;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            (Some(text[..end].to_string()), true)
        }
        other => (other, false),
    }
}

impl AgentTurnEventFrame {
    pub fn from_event(event: AgentTurnEvent) -> Self {
        let (body, body_truncated) = bound_frame_field(event.body);
        let (code, code_truncated) = bound_frame_field(event.code);
        Self {
            turn_id: event.turn_id.clone(),
            event: Some(AgentTurnEvent { body, code, ..event }),
            turn_update: None,
            payload_truncated: body_truncated || code_truncated,
        }
    }

    pub fn from_finish(turn_id: String, finish: &AgentTurnFinish) -> Self {
        let (final_message, final_truncated) = bound_frame_field(finish.final_message.clone());
        let (error_message, error_truncated) = bound_frame_field(finish.error_message.clone());
        Self {
            turn_id,
            event: None,
            turn_update: Some(AgentTurnUpdateFrame {
                status: finish.status.clone(),
                final_message,
                error_message,
                terminal_reason: finish.terminal_reason.clone(),
            }),
            payload_truncated: final_truncated || error_truncated,
        }
    }
}
