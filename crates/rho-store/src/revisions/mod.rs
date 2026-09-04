use rho_protocol::{
    ExecutionId, ExecutionTerminalOutcome, RevisionStamp, RevisionTransition, StateRevision,
    terminal_execution_revision_transition,
};
use rusqlite::{OptionalExtension, params};
use serde_json::json;
use thiserror::Error;

use crate::SemanticStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalRevisionOutcome {
    Advanced(RevisionTransition),
    Duplicate { state_revision_after: StateRevision },
}

#[derive(Debug, Error)]
pub enum StoreRevisionError {
    #[error("revision error: {0}")]
    Revision(#[from] rho_protocol::RevisionError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl SemanticStore {
    pub fn record_terminal_execution_revision(
        &mut self,
        terminal_event_id: &str,
        execution_id: &ExecutionId,
        before: RevisionStamp,
        outcome: ExecutionTerminalOutcome,
        may_mutate_workspace: bool,
    ) -> Result<TerminalRevisionOutcome, StoreRevisionError> {
        let tx = self.conn.transaction()?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT state_revision_after FROM terminal_revision_dedupe WHERE terminal_event_id = ?1",
                params![terminal_event_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(revision) = existing {
            tx.commit()?;
            return Ok(TerminalRevisionOutcome::Duplicate {
                state_revision_after: StateRevision(revision as u64),
            });
        }
        let transition =
            terminal_execution_revision_transition(before, outcome, may_mutate_workspace)?;
        tx.execute(
            "INSERT INTO terminal_revision_dedupe(
                terminal_event_id, execution_id, state_revision_after, project_revision_after
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                terminal_event_id,
                execution_id.as_str(),
                transition.after.state_revision.0 as i64,
                transition.after.project_revision.0 as i64,
            ],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO revisions(
                workspace_id, kernel_instance_id, state_revision, project_revision, source_event_id
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                transition.after.workspace_id.as_str(),
                transition.after.kernel_instance_id.as_str(),
                transition.after.state_revision.0 as i64,
                transition.after.project_revision.0 as i64,
                terminal_event_id,
            ],
        )?;
        let value = serde_json::to_string(&json!({
            "workspace_id": transition.after.workspace_id.as_str(),
            "kernel_instance_id": transition.after.kernel_instance_id.as_str(),
            "state_revision": transition.after.state_revision.0,
            "project_revision": transition.after.project_revision.0,
            "terminal_outcome": outcome,
        }))?;
        tx.execute(
            "INSERT OR REPLACE INTO current_projection(key, value_json, source_event_id)
             VALUES ('workspace_revision', ?1, ?2)",
            params![value, terminal_event_id],
        )?;
        tx.commit()?;
        Ok(TerminalRevisionOutcome::Advanced(transition))
    }
}
