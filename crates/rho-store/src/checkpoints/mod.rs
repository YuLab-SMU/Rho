use rho_protocol::{CheckpointDescriptor, CheckpointRestoreStrategy};
use rusqlite::params;
use thiserror::Error;

use crate::SemanticStore;

#[derive(Debug, Error)]
pub enum CheckpointStoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl SemanticStore {
    pub fn record_checkpoint_descriptor(
        &self,
        checkpoint: &CheckpointDescriptor,
        source_event_id: &str,
    ) -> Result<(), CheckpointStoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO checkpoints(
                checkpoint_id, scope, source_state_revision, source_project_revision,
                restore_strategy, environment_ref, code_ref, source_event_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                checkpoint.checkpoint_id.as_str(),
                checkpoint.scope.as_str(),
                checkpoint.source_revision.state_revision.0 as i64,
                checkpoint.source_revision.project_revision.0 as i64,
                checkpoint_restore_strategy_key(checkpoint.restore_strategy),
                checkpoint.environment_ref.as_str(),
                checkpoint.code_ref.as_str(),
                source_event_id,
            ],
        )?;
        Ok(())
    }
}

pub fn checkpoint_restore_strategy_key(strategy: CheckpointRestoreStrategy) -> &'static str {
    match strategy {
        CheckpointRestoreStrategy::Exact => "exact",
        CheckpointRestoreStrategy::Partial => "partial",
        CheckpointRestoreStrategy::RestartRequired => "restart_required",
        CheckpointRestoreStrategy::NonReversible => "non_reversible",
    }
}
