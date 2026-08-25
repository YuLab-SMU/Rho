use std::collections::BTreeSet;

use chrono::Utc;
use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Store, StoreError, normalize_project_root};

const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 64;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_INLINE_CHUNK_BYTES: usize = 64 * 1024;
const MAX_APPEND_CHUNKS: usize = 1024;
const MAX_PAGE_CHUNKS: usize = 200;
const MIN_PAGE_BYTES: usize = 64 * 1024;
const MAX_PAGE_BYTES: usize = 1024 * 1024;
const MAX_CONTEXT_ITEMS: usize = 512;
const MAX_SUBMITTED_CODE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeExecutionDraft {
    pub execution_id: String,
    pub project_root: String,
    pub run_id: Option<String>,
    pub runtime_provider_id: String,
    pub runtime_instance_id: String,
    pub runtime_activation_generation: i64,
    pub console_instance_id: String,
    pub submitted_code: String,
    pub workspace_id: Option<String>,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    pub document_version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeExecution {
    pub execution_id: String,
    pub project_root: String,
    pub run_id: Option<String>,
    pub runtime_provider_id: String,
    pub runtime_instance_id: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub runtime_activation_generation: i64,
    pub console_instance_id: String,
    pub submitted_code: String,
    pub workspace_id: Option<String>,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub document_version: Option<i64>,
    #[specta(type = crate::RuntimeExecutionStatus)]
    pub status: String,
    pub terminal_reason: Option<String>,
    #[specta(type = crate::RuntimeOutputState)]
    pub output_state: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub last_sequence: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub output_bytes: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeExecutionFinish {
    pub status: String,
    pub terminal_reason: Option<String>,
    pub output_state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeExecutionMutationOutcome {
    Applied,
    Unchanged,
    NotFound,
    NotActive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage_kind", rename_all = "snake_case")]
pub enum RuntimeOutputPayload {
    InlineText {
        text: String,
    },
    InlineJson {
        json: String,
    },
    RecordRef {
        reference_kind: String,
        reference_id: String,
        payload_bytes: i64,
        payload_sha256: String,
    },
    Tombstone {
        metadata_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeOutputDraft {
    pub producer_sequence: i64,
    pub projection_slot: i64,
    pub source_kind: String,
    pub presentation_kind: String,
    pub media_type: Option<String>,
    pub payload: RuntimeOutputPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeOutputChunk {
    pub execution_id: String,
    pub project_root: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub sequence: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub producer_sequence: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub projection_slot: i64,
    pub source_kind: String,
    #[specta(type = crate::RuntimeOutputPresentationKind)]
    pub presentation_kind: String,
    pub media_type: Option<String>,
    #[specta(type = crate::RuntimeOutputStorageKind)]
    pub storage_kind: String,
    pub text_payload: Option<String>,
    pub json_payload: Option<String>,
    #[specta(type = Option<crate::RuntimeOutputReferenceKind>)]
    pub reference_kind: Option<String>,
    pub reference_id: Option<String>,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub payload_bytes: i64,
    pub payload_sha256: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeOutputAppendResult {
    pub committed: Vec<RuntimeOutputChunk>,
    pub duplicate_count: usize,
    pub capture_stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeOutputPage {
    pub execution_id: String,
    pub project_root: String,
    #[specta(type = crate::RuntimeExecutionStatus)]
    pub status: String,
    #[specta(type = crate::RuntimeOutputState)]
    pub output_state: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub total_output_bytes: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub after_sequence: i64,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub before_sequence: Option<i64>,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub previous_sequence: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub next_sequence: i64,
    pub has_older: bool,
    pub has_more: bool,
    pub chunks: Vec<RuntimeOutputChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeOutputSearchHit {
    pub execution_id: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub sequence: i64,
    pub presentation_kind: String,
    pub storage_kind: String,
    pub preview: String,
    #[specta(type = Option<crate::RuntimeOutputReferenceKind>)]
    pub reference_kind: Option<String>,
    pub reference_id: Option<String>,
    pub payload_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeOutputSearchResult {
    pub query: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub searched_execution_count: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub matched_execution_count: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub incomplete_execution_count: i64,
    pub truncated: bool,
    pub hits: Vec<RuntimeOutputSearchHit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeOutputPolicy {
    pub project_root: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub revision: i64,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub max_runtime_output_bytes_per_execution: Option<i64>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub runtime_output_project_warning_bytes: Option<i64>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub max_runtime_execution_rows: Option<i64>,
    pub auto_prune_enabled: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeOutputPolicyUpdate {
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub expected_revision: i64,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub max_runtime_output_bytes_per_execution: Option<i64>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub runtime_output_project_warning_bytes: Option<i64>,
    #[specta(type = Option<crate::RuntimeOutputIpcNumber>)]
    pub max_runtime_execution_rows: Option<i64>,
    pub auto_prune_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeOutputPruneResult {
    pub outcome: RuntimeExecutionMutationOutcome,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub pruned_chunk_count: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub reclaimed_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RuntimeExecutionDeleteResult {
    pub outcome: RuntimeExecutionMutationOutcome,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub deleted_output_chunk_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnContextItemDraft {
    pub context_item_id: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub ordinal: i64,
    pub source_kind: String,
    pub source_id: Option<String>,
    pub source_revision: Option<String>,
    pub source_sha256: String,
    pub trust_class: String,
    pub capacity_source: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub original_bytes: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub included_bytes: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub estimated_tokens: i64,
    pub disposition: String,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentTurnContextItem {
    pub context_item_id: String,
    pub turn_id: String,
    pub project_root: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub ordinal: i64,
    pub source_kind: String,
    pub source_id: Option<String>,
    pub source_revision: Option<String>,
    pub source_sha256: String,
    pub trust_class: String,
    pub capacity_source: String,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub original_bytes: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub included_bytes: i64,
    #[specta(type = crate::RuntimeOutputIpcNumber)]
    pub estimated_tokens: i64,
    pub disposition: String,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone)]
struct PreparedOutput {
    producer_sequence: i64,
    projection_slot: i64,
    source_kind: String,
    presentation_kind: String,
    media_type: Option<String>,
    storage_kind: String,
    text_payload: Option<String>,
    json_payload: Option<String>,
    reference_kind: Option<String>,
    reference_id: Option<String>,
    payload_bytes: i64,
    payload_sha256: String,
}

impl<C> Store<C>
where
    C: std::ops::Deref<Target = rusqlite::Connection> + std::ops::DerefMut,
{
    pub fn create_runtime_execution(
        &mut self,
        draft: &RuntimeExecutionDraft,
    ) -> Result<RuntimeExecution, StoreError> {
        validate_execution_draft(draft)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(run_id) = draft.run_id.as_deref() {
            let run_exists = transaction
                .query_row(
                    "SELECT 1 FROM runs WHERE project_root = ?1 AND run_id = ?2",
                    params![draft.project_root, run_id],
                    |_row| Ok(()),
                )
                .optional()?
                .is_some();
            if !run_exists {
                return Err(StoreError::Validation(
                    "runtime execution Run is unavailable in the active project".to_string(),
                ));
            }
        }

        if let Some(existing) =
            load_execution(&transaction, &draft.project_root, &draft.execution_id)?
        {
            if execution_identity_matches(&existing, draft) {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(StoreError::Validation(
                "runtime execution identity already exists with different admission data"
                    .to_string(),
            ));
        }

        transaction.execute(
            "INSERT INTO runtime_executions(
                execution_id, project_root, run_id, runtime_provider_id,
                runtime_instance_id, runtime_activation_generation,
                console_instance_id, workspace_id, source_path, execution_mode,
                document_version, submitted_code, status, output_state, started_at
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                'admitted', 'collecting', ?13
             )",
            params![
                draft.execution_id,
                draft.project_root,
                draft.run_id,
                draft.runtime_provider_id,
                draft.runtime_instance_id,
                draft.runtime_activation_generation,
                draft.console_instance_id,
                draft.workspace_id,
                draft.source_path,
                draft.execution_mode,
                draft.document_version,
                draft.submitted_code,
                Utc::now().to_rfc3339(),
            ],
        )?;
        let created = load_execution(&transaction, &draft.project_root, &draft.execution_id)?
            .ok_or_else(|| {
                StoreError::Validation("new Runtime execution could not be reloaded".to_string())
            })?;
        transaction.commit()?;
        Ok(created)
    }

    pub fn get_runtime_execution(
        &self,
        project_root: &str,
        execution_id: &str,
    ) -> Result<Option<RuntimeExecution>, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        load_execution(&self.connection, project_root, execution_id)
    }

    pub fn link_runtime_execution_run(
        &mut self,
        project_root: &str,
        execution_id: &str,
        run_id: &str,
    ) -> Result<RuntimeExecutionMutationOutcome, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        validate_identifier(run_id, "run_id")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(execution) = load_execution(&transaction, project_root, execution_id)? else {
            return Ok(RuntimeExecutionMutationOutcome::NotFound);
        };
        if execution.run_id.as_deref() == Some(run_id) {
            transaction.commit()?;
            return Ok(RuntimeExecutionMutationOutcome::Unchanged);
        }
        if execution.run_id.is_some() {
            transaction.commit()?;
            return Ok(RuntimeExecutionMutationOutcome::NotActive);
        }
        let run_exists = transaction
            .query_row(
                "SELECT 1 FROM runs WHERE project_root = ?1 AND run_id = ?2",
                params![project_root, run_id],
                |_row| Ok(()),
            )
            .optional()?
            .is_some();
        if !run_exists {
            return Err(StoreError::Validation(
                "Runtime execution Run is unavailable in the active project".to_string(),
            ));
        }
        transaction.execute(
            "UPDATE runtime_executions SET run_id = ?3
             WHERE project_root = ?1 AND execution_id = ?2 AND run_id IS NULL",
            params![project_root, execution_id, run_id],
        )?;
        transaction.commit()?;
        Ok(RuntimeExecutionMutationOutcome::Applied)
    }

    pub fn list_runtime_executions(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<RuntimeExecution>, StoreError> {
        self.list_runtime_executions_before(project_root, limit, None)
    }

    pub fn list_runtime_executions_before(
        &self,
        project_root: &str,
        limit: Option<usize>,
        before: Option<(&str, &str)>,
    ) -> Result<Vec<RuntimeExecution>, StoreError> {
        validate_project_root(project_root)?;
        let limit = limit.unwrap_or(50);
        if limit == 0 || limit > 100 {
            return Err(StoreError::Validation(
                "Runtime execution list limit must be 1..=100".to_string(),
            ));
        }
        if let Some((started_at, execution_id)) = before {
            validate_optional_text(Some(started_at), 128, "started_at cursor")?;
            validate_identifier(execution_id, "execution_id cursor")?;
        }
        let mut statement = self.connection.prepare(
            "SELECT execution_id, project_root, run_id, runtime_provider_id,
                    runtime_instance_id, runtime_activation_generation,
                    console_instance_id, workspace_id, source_path, execution_mode,
                    document_version, submitted_code, status, terminal_reason, output_state,
                    last_sequence, output_bytes, started_at, finished_at
             FROM runtime_executions
             WHERE project_root = ?1 AND (
               ?3 IS NULL OR started_at < ?3 OR (started_at = ?3 AND execution_id < ?4)
             )
             ORDER BY started_at DESC, execution_id DESC
             LIMIT ?2",
        )?;
        let (before_started_at, before_execution_id) = before
            .map(|(started_at, execution_id)| (Some(started_at), Some(execution_id)))
            .unwrap_or((None, None));
        let records = statement
            .query_map(
                params![
                    project_root,
                    limit as i64,
                    before_started_at,
                    before_execution_id
                ],
                decode_execution,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }

    pub fn search_runtime_output(
        &self,
        project_root: &str,
        query: &str,
        console_instance_id: Option<&str>,
        started_after: Option<&str>,
        limit: usize,
    ) -> Result<RuntimeOutputSearchResult, StoreError> {
        validate_project_root(project_root)?;
        let query = query.trim();
        if query.is_empty() {
            return Err(StoreError::Validation(
                "Runtime output search query cannot be empty".to_string(),
            ));
        }
        validate_optional_text(Some(query), 8 * 1024, "Runtime output search query")?;
        if let Some(console_instance_id) = console_instance_id {
            validate_identifier(console_instance_id, "console_instance_id")?;
        }
        validate_optional_text(started_after, 128, "started_after")?;
        if limit == 0 || limit > 200 {
            return Err(StoreError::Validation(
                "Runtime output search limit must be 1..=200".to_string(),
            ));
        }
        let scope = "e.project_root = ?1
          AND (?2 IS NULL OR e.console_instance_id = ?2)
          AND (?3 IS NULL OR e.started_at > ?3)";
        let searched_execution_count = self.connection.query_row(
            &format!("SELECT COUNT(*) FROM runtime_executions e WHERE {scope}"),
            params![project_root, console_instance_id, started_after],
            |row| row.get(0),
        )?;
        let incomplete_execution_count = self.connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM runtime_executions e
                 WHERE {scope} AND e.output_state IN ('partial', 'unavailable', 'pruned')"
            ),
            params![project_root, console_instance_id, started_after],
            |row| row.get(0),
        )?;
        let match_counts_sql = format!(
            "SELECT COUNT(DISTINCT execution_id), COUNT(*)
             FROM (
               SELECT e.execution_id
               FROM runtime_executions e
               WHERE {scope} AND instr(lower(e.submitted_code), lower(?4)) > 0
               UNION ALL
               SELECT e.execution_id
               FROM runtime_executions e
               JOIN runtime_output_chunks c
                 ON c.project_root = e.project_root AND c.execution_id = e.execution_id
               WHERE {scope} AND instr(lower(coalesce(
                 c.text_payload, c.json_payload, c.reference_id, ''
               )), lower(?4)) > 0
             )"
        );
        let (matched_execution_count, total_match_count): (i64, i64) = self.connection.query_row(
            &match_counts_sql,
            params![project_root, console_instance_id, started_after, query],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let sql = format!(
            "SELECT execution_id, sequence, presentation_kind, storage_kind, preview,
                    reference_kind, reference_id, payload_sha256, digest_source
             FROM (
               SELECT e.execution_id AS execution_id, 0 AS sequence,
                      'code' AS presentation_kind, 'inline_text' AS storage_kind,
                      substr(e.submitted_code, 1, 1000) AS preview,
                      NULL AS reference_kind, NULL AS reference_id,
                      '' AS payload_sha256, e.submitted_code AS digest_source,
                      e.started_at AS started_at
               FROM runtime_executions e
               WHERE {scope} AND instr(lower(e.submitted_code), lower(?4)) > 0
               UNION ALL
               SELECT e.execution_id, c.sequence, c.presentation_kind, c.storage_kind,
                      substr(coalesce(c.text_payload, c.json_payload, c.reference_id, ''), 1, 1000),
                      c.reference_kind, c.reference_id, c.payload_sha256,
                      NULL AS digest_source, e.started_at
               FROM runtime_executions e
               JOIN runtime_output_chunks c
                 ON c.project_root = e.project_root AND c.execution_id = e.execution_id
               WHERE {scope} AND instr(lower(coalesce(
                 c.text_payload, c.json_payload, c.reference_id, ''
               )), lower(?4)) > 0
             )
             ORDER BY started_at DESC, execution_id DESC, sequence ASC
             LIMIT ?5"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let hits = statement
            .query_map(
                params![
                    project_root,
                    console_instance_id,
                    started_after,
                    query,
                    (limit + 1) as i64
                ],
                |row| {
                    let stored_sha256: String = row.get(7)?;
                    let digest_source: Option<String> = row.get(8)?;
                    Ok(RuntimeOutputSearchHit {
                        execution_id: row.get(0)?,
                        sequence: row.get(1)?,
                        presentation_kind: row.get(2)?,
                        storage_kind: row.get(3)?,
                        preview: row.get(4)?,
                        reference_kind: row.get(5)?,
                        reference_id: row.get(6)?,
                        payload_sha256: digest_source
                            .as_deref()
                            .map(|source| sha256_hex(source.as_bytes()))
                            .unwrap_or(stored_sha256),
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let truncated = total_match_count > limit as i64;
        let mut hits = hits.into_iter().take(limit).collect::<Vec<_>>();
        hits.shrink_to_fit();
        Ok(RuntimeOutputSearchResult {
            query: query.to_string(),
            searched_execution_count,
            matched_execution_count,
            incomplete_execution_count,
            truncated,
            hits,
        })
    }

    pub fn get_runtime_output_policy(
        &self,
        project_root: &str,
    ) -> Result<RuntimeOutputPolicy, StoreError> {
        validate_project_root(project_root)?;
        load_runtime_output_policy(&self.connection, project_root)
    }

    pub fn update_runtime_output_policy(
        &mut self,
        project_root: &str,
        update: &RuntimeOutputPolicyUpdate,
    ) -> Result<RuntimeOutputPolicy, StoreError> {
        validate_project_root(project_root)?;
        validate_runtime_output_policy_values(
            update.max_runtime_output_bytes_per_execution,
            update.runtime_output_project_warning_bytes,
            update.max_runtime_execution_rows,
            update.auto_prune_enabled,
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_runtime_output_policy(&transaction, project_root)?;
        if current.revision != update.expected_revision {
            return Err(StoreError::Validation(
                "Runtime output policy changed while it was being edited".to_string(),
            ));
        }
        let revision = current.revision.checked_add(1).ok_or_else(|| {
            StoreError::Validation("Runtime output policy revision overflowed".to_string())
        })?;
        let updated_at = Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO project_runtime_output_policies(
                project_root, revision, max_runtime_output_bytes_per_execution,
                runtime_output_project_warning_bytes, max_runtime_execution_rows,
                auto_prune_enabled, updated_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_root) DO UPDATE SET
                revision = excluded.revision,
                max_runtime_output_bytes_per_execution = excluded.max_runtime_output_bytes_per_execution,
                runtime_output_project_warning_bytes = excluded.runtime_output_project_warning_bytes,
                max_runtime_execution_rows = excluded.max_runtime_execution_rows,
                auto_prune_enabled = excluded.auto_prune_enabled,
                updated_at = excluded.updated_at",
            params![
                project_root,
                revision,
                update.max_runtime_output_bytes_per_execution,
                update.runtime_output_project_warning_bytes,
                update.max_runtime_execution_rows,
                i64::from(update.auto_prune_enabled),
                updated_at,
            ],
        )?;
        let policy = load_runtime_output_policy(&transaction, project_root)?;
        transaction.commit()?;
        Ok(policy)
    }

    pub fn mark_runtime_execution_running(
        &mut self,
        project_root: &str,
        execution_id: &str,
    ) -> Result<RuntimeExecutionMutationOutcome, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(existing) = load_execution(&transaction, project_root, execution_id)? else {
            return Ok(RuntimeExecutionMutationOutcome::NotFound);
        };
        let outcome = match existing.status.as_str() {
            "admitted" => {
                transaction.execute(
                    "UPDATE runtime_executions SET status = 'running'
                     WHERE project_root = ?1 AND execution_id = ?2 AND status = 'admitted'",
                    params![project_root, execution_id],
                )?;
                RuntimeExecutionMutationOutcome::Applied
            }
            "running" => RuntimeExecutionMutationOutcome::Unchanged,
            _ => RuntimeExecutionMutationOutcome::NotActive,
        };
        transaction.commit()?;
        Ok(outcome)
    }

    pub fn finish_runtime_execution(
        &mut self,
        project_root: &str,
        execution_id: &str,
        finish: &RuntimeExecutionFinish,
    ) -> Result<RuntimeExecutionMutationOutcome, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        if !matches!(
            finish.status.as_str(),
            "completed" | "failed" | "interrupted"
        ) {
            return Err(StoreError::Validation(
                "Runtime execution terminal status is unsupported".to_string(),
            ));
        }
        if !matches!(
            finish.output_state.as_str(),
            "complete" | "partial" | "unavailable" | "pruned"
        ) {
            return Err(StoreError::Validation(
                "Runtime execution terminal output state is unsupported".to_string(),
            ));
        }
        validate_optional_text(finish.terminal_reason.as_deref(), 2048, "terminal_reason")?;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(existing) = load_execution(&transaction, project_root, execution_id)? else {
            return Ok(RuntimeExecutionMutationOutcome::NotFound);
        };
        if matches!(
            existing.status.as_str(),
            "completed" | "failed" | "interrupted"
        ) {
            let requested_state = if existing.output_state == "partial" {
                "partial"
            } else {
                finish.output_state.as_str()
            };
            let outcome = if existing.status == finish.status
                && existing.output_state == requested_state
                && existing.terminal_reason == finish.terminal_reason
            {
                RuntimeExecutionMutationOutcome::Unchanged
            } else {
                RuntimeExecutionMutationOutcome::NotActive
            };
            transaction.commit()?;
            return Ok(outcome);
        }
        let output_state = if existing.output_state == "partial" {
            "partial"
        } else {
            finish.output_state.as_str()
        };
        transaction.execute(
            "UPDATE runtime_executions
             SET status = ?3, terminal_reason = ?4, output_state = ?5, finished_at = ?6
             WHERE project_root = ?1 AND execution_id = ?2
               AND status IN ('admitted', 'running')",
            params![
                project_root,
                execution_id,
                finish.status,
                finish.terminal_reason,
                output_state,
                Utc::now().to_rfc3339(),
            ],
        )?;
        transaction.commit()?;
        Ok(RuntimeExecutionMutationOutcome::Applied)
    }

    pub fn reconcile_interrupted_runtime_executions(
        &mut self,
        project_root: &str,
    ) -> Result<i64, StoreError> {
        validate_project_root(project_root)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active = {
            let mut statement = transaction.prepare(
                "SELECT execution_id, last_sequence, output_bytes, output_state,
                        COALESCE((SELECT MAX(producer_sequence)
                            FROM runtime_output_chunks AS output
                            WHERE output.project_root = execution.project_root
                              AND output.execution_id = execution.execution_id), -1)
                 FROM runtime_executions AS execution
                 WHERE project_root = ?1 AND status IN ('admitted', 'running')
                 ORDER BY started_at ASC, execution_id ASC",
            )?;
            statement
                .query_map(params![project_root], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let finished_at = Utc::now().to_rfc3339();
        for (execution_id, last_sequence, output_bytes, output_state, producer_sequence) in &active
        {
            let metadata_json = serde_json::to_string(&serde_json::json!({
                "reason": "desktop_restarted",
                "message": "The desktop restarted before this Runtime execution reached a terminal receipt.",
            }))?;
            let tombstone = PreparedOutput {
                producer_sequence: producer_sequence + 1,
                projection_slot: 0,
                source_kind: "runtime.recovery".to_string(),
                presentation_kind: "status".to_string(),
                media_type: Some("application/json".to_string()),
                storage_kind: "tombstone".to_string(),
                text_payload: None,
                json_payload: Some(metadata_json.clone()),
                reference_kind: None,
                reference_id: None,
                payload_bytes: metadata_json.len() as i64,
                payload_sha256: sha256_hex(metadata_json.as_bytes()),
            };
            let chunk = insert_chunk(
                &transaction,
                project_root,
                execution_id,
                last_sequence + 1,
                &tombstone,
            )?;
            let next_output_state = if output_state == "partial" || *output_bytes > 0 {
                "partial"
            } else {
                "unavailable"
            };
            transaction.execute(
                "UPDATE runtime_executions
                 SET status = 'failed',
                     terminal_reason = 'Desktop restarted before Runtime completion.',
                     output_state = ?3, last_sequence = ?4,
                     output_bytes = ?5, finished_at = ?6
                 WHERE project_root = ?1 AND execution_id = ?2
                   AND status IN ('admitted', 'running')",
                params![
                    project_root,
                    execution_id,
                    next_output_state,
                    chunk.sequence,
                    output_bytes.saturating_add(chunk.payload_bytes),
                    finished_at,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(active.len() as i64)
    }

    pub fn append_runtime_output(
        &mut self,
        project_root: &str,
        execution_id: &str,
        drafts: &[RuntimeOutputDraft],
        capture_limit_bytes: Option<i64>,
    ) -> Result<RuntimeOutputAppendResult, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        if drafts.is_empty() {
            return Err(StoreError::Validation(
                "Runtime output append requires at least one item".to_string(),
            ));
        }
        if capture_limit_bytes.is_some_and(|limit| limit < 0) {
            return Err(StoreError::Validation(
                "Runtime output capture limit cannot be negative".to_string(),
            ));
        }
        let prepared = prepare_outputs(drafts)?;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(execution) = load_execution(&transaction, project_root, execution_id)? else {
            return Err(StoreError::Validation(
                "Runtime execution is unavailable in the active project".to_string(),
            ));
        };
        if !matches!(execution.status.as_str(), "admitted" | "running") {
            return Err(StoreError::Validation(
                "Runtime output cannot be appended after execution completion".to_string(),
            ));
        }

        let mut last_sequence = execution.last_sequence;
        let mut output_bytes = execution.output_bytes;
        let mut output_state = execution.output_state;
        let mut committed = Vec::new();
        let mut duplicate_count = 0;
        let mut capture_stopped = output_state == "partial";

        for output in prepared {
            if let Some(existing) = load_chunk_by_producer(
                &transaction,
                project_root,
                execution_id,
                output.producer_sequence,
                output.projection_slot,
            )? {
                if !prepared_matches_chunk(&output, &existing) {
                    return Err(StoreError::Validation(
                        "Runtime output producer identity was reused with different content"
                            .to_string(),
                    ));
                }
                duplicate_count += 1;
                continue;
            }
            if capture_stopped {
                continue;
            }
            validate_record_reference(&transaction, project_root, &output)?;

            if capture_limit_bytes
                .is_some_and(|limit| output_bytes.saturating_add(output.payload_bytes) > limit)
            {
                let tombstone = capture_tombstone(&output, output_bytes)?;
                last_sequence += 1;
                let chunk = insert_chunk(
                    &transaction,
                    project_root,
                    execution_id,
                    last_sequence,
                    &tombstone,
                )?;
                output_bytes = output_bytes.saturating_add(tombstone.payload_bytes);
                output_state = "partial".to_string();
                capture_stopped = true;
                committed.push(chunk);
                break;
            }

            last_sequence += 1;
            let chunk = insert_chunk(
                &transaction,
                project_root,
                execution_id,
                last_sequence,
                &output,
            )?;
            output_bytes = output_bytes.saturating_add(output.payload_bytes);
            committed.push(chunk);
        }

        if !committed.is_empty() {
            transaction.execute(
                "UPDATE runtime_executions
                 SET last_sequence = ?3, output_bytes = ?4, output_state = ?5
                 WHERE project_root = ?1 AND execution_id = ?2",
                params![
                    project_root,
                    execution_id,
                    last_sequence,
                    output_bytes,
                    output_state,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(RuntimeOutputAppendResult {
            committed,
            duplicate_count,
            capture_stopped,
        })
    }

    pub fn runtime_output_page(
        &self,
        project_root: &str,
        execution_id: &str,
        after_sequence: i64,
        page_size: usize,
        byte_limit: usize,
    ) -> Result<RuntimeOutputPage, StoreError> {
        self.runtime_output_page_direction(
            project_root,
            execution_id,
            after_sequence,
            None,
            page_size,
            byte_limit,
        )
    }

    pub fn runtime_output_page_before(
        &self,
        project_root: &str,
        execution_id: &str,
        before_sequence: i64,
        page_size: usize,
        byte_limit: usize,
    ) -> Result<RuntimeOutputPage, StoreError> {
        self.runtime_output_page_direction(
            project_root,
            execution_id,
            0,
            Some(before_sequence),
            page_size,
            byte_limit,
        )
    }

    fn runtime_output_page_direction(
        &self,
        project_root: &str,
        execution_id: &str,
        after_sequence: i64,
        before_sequence: Option<i64>,
        page_size: usize,
        byte_limit: usize,
    ) -> Result<RuntimeOutputPage, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        if after_sequence < 0 {
            return Err(StoreError::Validation(
                "Runtime output cursor cannot be negative".to_string(),
            ));
        }
        if before_sequence.is_some_and(|sequence| sequence <= 0) {
            return Err(StoreError::Validation(
                "Runtime output reverse cursor must be positive".to_string(),
            ));
        }
        if page_size == 0 || page_size > MAX_PAGE_CHUNKS {
            return Err(StoreError::Validation(
                "Runtime output page size must be 1..=200".to_string(),
            ));
        }
        if !(MIN_PAGE_BYTES..=MAX_PAGE_BYTES).contains(&byte_limit) {
            return Err(StoreError::Validation(
                "Runtime output page byte limit must be 64 KiB..=1 MiB".to_string(),
            ));
        }
        let Some(execution) = load_execution(&self.connection, project_root, execution_id)? else {
            return Err(StoreError::Validation(
                "Runtime execution is unavailable in the active project".to_string(),
            ));
        };
        let query = if before_sequence.is_some() {
            "SELECT execution_id, project_root, sequence, producer_sequence,
                    projection_slot, source_kind, presentation_kind, media_type,
                    storage_kind, text_payload, json_payload, reference_kind,
                    reference_id, payload_bytes, payload_sha256, created_at
             FROM runtime_output_chunks
             WHERE project_root = ?1 AND execution_id = ?2 AND sequence < ?3
             ORDER BY sequence DESC
             LIMIT ?4"
        } else {
            "SELECT execution_id, project_root, sequence, producer_sequence,
                    projection_slot, source_kind, presentation_kind, media_type,
                    storage_kind, text_payload, json_payload, reference_kind,
                    reference_id, payload_bytes, payload_sha256, created_at
             FROM runtime_output_chunks
             WHERE project_root = ?1 AND execution_id = ?2 AND sequence > ?3
             ORDER BY sequence ASC
             LIMIT ?4"
        };
        let mut statement = self.connection.prepare(query)?;
        let cursor = before_sequence.unwrap_or(after_sequence);
        let mut candidates = statement
            .query_map(
                params![project_root, execution_id, cursor, (page_size + 1) as i64],
                decode_chunk,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let reverse = before_sequence.is_some();
        let mut chunks = Vec::new();
        let mut page_bytes = 0usize;
        let mut stopped_for_bytes = false;
        for candidate in candidates.iter().take(page_size) {
            let candidate_bytes = usize::try_from(candidate.payload_bytes).unwrap_or(usize::MAX);
            if !chunks.is_empty() && page_bytes.saturating_add(candidate_bytes) > byte_limit {
                stopped_for_bytes = true;
                break;
            }
            page_bytes = page_bytes.saturating_add(candidate_bytes);
            chunks.push(candidate.clone());
        }
        if reverse {
            chunks.reverse();
            candidates.reverse();
        }
        let previous_sequence = chunks.first().map_or(cursor, |chunk| chunk.sequence);
        let next_sequence = chunks.last().map_or(after_sequence, |chunk| chunk.sequence);
        let has_older = if chunks.is_empty() {
            false
        } else {
            stopped_for_bytes
                || candidates.len() > chunks.len()
                || self
                    .connection
                    .query_row(
                        "SELECT 1 FROM runtime_output_chunks
                         WHERE project_root = ?1 AND execution_id = ?2 AND sequence < ?3
                         LIMIT 1",
                        params![project_root, execution_id, previous_sequence],
                        |_row| Ok(()),
                    )
                    .optional()?
                    .is_some()
        };
        let has_more = if reverse {
            self.connection
                .query_row(
                    "SELECT 1 FROM runtime_output_chunks
                     WHERE project_root = ?1 AND execution_id = ?2 AND sequence > ?3
                     LIMIT 1",
                    params![project_root, execution_id, next_sequence],
                    |_row| Ok(()),
                )
                .optional()?
                .is_some()
        } else {
            stopped_for_bytes
                || candidates.len() > chunks.len()
                || self
                    .connection
                    .query_row(
                        "SELECT 1 FROM runtime_output_chunks
                     WHERE project_root = ?1 AND execution_id = ?2 AND sequence > ?3
                     LIMIT 1",
                        params![project_root, execution_id, next_sequence],
                        |_row| Ok(()),
                    )
                    .optional()?
                    .is_some()
        };
        Ok(RuntimeOutputPage {
            execution_id: execution_id.to_string(),
            project_root: project_root.to_string(),
            status: execution.status,
            output_state: execution.output_state,
            total_output_bytes: execution.output_bytes,
            after_sequence,
            before_sequence,
            previous_sequence,
            next_sequence,
            has_older,
            has_more,
            chunks,
        })
    }

    pub fn prune_runtime_output_payloads(
        &mut self,
        project_root: &str,
        execution_id: &str,
    ) -> Result<RuntimeOutputPruneResult, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(execution) = load_execution(&transaction, project_root, execution_id)? else {
            return Ok(RuntimeOutputPruneResult {
                outcome: RuntimeExecutionMutationOutcome::NotFound,
                pruned_chunk_count: 0,
                reclaimed_bytes: 0,
            });
        };
        if matches!(execution.status.as_str(), "admitted" | "running") {
            transaction.commit()?;
            return Ok(RuntimeOutputPruneResult {
                outcome: RuntimeExecutionMutationOutcome::NotActive,
                pruned_chunk_count: 0,
                reclaimed_bytes: 0,
            });
        }
        let candidates = {
            let mut statement = transaction.prepare(
                "SELECT sequence, storage_kind, payload_bytes, payload_sha256
                 FROM runtime_output_chunks
                 WHERE project_root = ?1 AND execution_id = ?2
                   AND storage_kind IN ('inline_text', 'inline_json')
                 ORDER BY sequence ASC",
            )?;
            statement
                .query_map(params![project_root, execution_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        if candidates.is_empty() {
            transaction.commit()?;
            return Ok(RuntimeOutputPruneResult {
                outcome: RuntimeExecutionMutationOutcome::Unchanged,
                pruned_chunk_count: 0,
                reclaimed_bytes: 0,
            });
        }

        let pruned_at = Utc::now().to_rfc3339();
        let mut original_bytes = 0i64;
        let mut tombstone_bytes = 0i64;
        for (sequence, storage_kind, payload_bytes, payload_sha256) in &candidates {
            let metadata_json = serde_json::to_string(&serde_json::json!({
                "reason": "pruned",
                "pruned_at": pruned_at,
                "original_storage_kind": storage_kind,
                "original_payload_bytes": payload_bytes,
                "original_payload_sha256": payload_sha256,
            }))?;
            let metadata_bytes = i64::try_from(metadata_json.len()).map_err(|_| {
                StoreError::Validation("Runtime output prune tombstone is too large".to_string())
            })?;
            let metadata_sha256 = sha256_hex(metadata_json.as_bytes());
            transaction.execute(
                "UPDATE runtime_output_chunks
                 SET presentation_kind = 'status', media_type = 'application/json',
                     storage_kind = 'tombstone', text_payload = NULL,
                     json_payload = ?4, reference_kind = NULL, reference_id = NULL,
                     payload_bytes = ?5, payload_sha256 = ?6
                 WHERE project_root = ?1 AND execution_id = ?2 AND sequence = ?3",
                params![
                    project_root,
                    execution_id,
                    sequence,
                    metadata_json,
                    metadata_bytes,
                    metadata_sha256,
                ],
            )?;
            original_bytes = original_bytes.saturating_add(*payload_bytes);
            tombstone_bytes = tombstone_bytes.saturating_add(metadata_bytes);
        }
        let retained_bytes: i64 = transaction.query_row(
            "SELECT COALESCE(SUM(payload_bytes), 0)
             FROM runtime_output_chunks
             WHERE project_root = ?1 AND execution_id = ?2",
            params![project_root, execution_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE runtime_executions
             SET output_state = 'pruned', output_bytes = ?3
             WHERE project_root = ?1 AND execution_id = ?2",
            params![project_root, execution_id, retained_bytes],
        )?;
        transaction.commit()?;
        Ok(RuntimeOutputPruneResult {
            outcome: RuntimeExecutionMutationOutcome::Applied,
            pruned_chunk_count: candidates.len() as i64,
            reclaimed_bytes: original_bytes.saturating_sub(tombstone_bytes),
        })
    }

    pub fn delete_runtime_execution_record(
        &mut self,
        project_root: &str,
        execution_id: &str,
    ) -> Result<RuntimeExecutionDeleteResult, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(execution_id, "execution_id")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(execution) = load_execution(&transaction, project_root, execution_id)? else {
            return Ok(RuntimeExecutionDeleteResult {
                outcome: RuntimeExecutionMutationOutcome::NotFound,
                deleted_output_chunk_count: 0,
            });
        };
        if matches!(execution.status.as_str(), "admitted" | "running") {
            transaction.commit()?;
            return Ok(RuntimeExecutionDeleteResult {
                outcome: RuntimeExecutionMutationOutcome::NotActive,
                deleted_output_chunk_count: 0,
            });
        }
        let referenced: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM agent_turn_context_items
             WHERE project_root = ?1 AND source_kind = 'runtime_output'
               AND (source_id = ?2 OR substr(source_id, 1, length(?2) + 1) = ?2 || ':')",
            params![project_root, execution_id],
            |row| row.get(0),
        )?;
        if referenced > 0 {
            return Err(StoreError::Validation(
                "Runtime execution is retained by an Agent context receipt".to_string(),
            ));
        }
        let output_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM runtime_output_chunks
             WHERE project_root = ?1 AND execution_id = ?2",
            params![project_root, execution_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "DELETE FROM runtime_executions WHERE project_root = ?1 AND execution_id = ?2",
            params![project_root, execution_id],
        )?;
        transaction.commit()?;
        Ok(RuntimeExecutionDeleteResult {
            outcome: RuntimeExecutionMutationOutcome::Applied,
            deleted_output_chunk_count: output_count,
        })
    }

    pub fn record_agent_turn_context_items(
        &mut self,
        project_root: &str,
        turn_id: &str,
        drafts: &[AgentTurnContextItemDraft],
    ) -> Result<Vec<AgentTurnContextItem>, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(turn_id, "turn_id")?;
        if drafts.len() > MAX_CONTEXT_ITEMS {
            return Err(StoreError::Validation(
                "Agent context receipt cannot exceed 512 items".to_string(),
            ));
        }
        validate_context_items(drafts)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let turn_exists = transaction
            .query_row(
                "SELECT 1 FROM agent_turns WHERE project_root = ?1 AND turn_id = ?2",
                params![project_root, turn_id],
                |_row| Ok(()),
            )
            .optional()?
            .is_some();
        if !turn_exists {
            return Err(StoreError::Validation(
                "Agent Turn is unavailable in the active project".to_string(),
            ));
        }
        let existing_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM agent_turn_context_items
             WHERE project_root = ?1 AND turn_id = ?2",
            params![project_root, turn_id],
            |row| row.get(0),
        )?;
        if existing_count != 0 {
            return Err(StoreError::Validation(
                "Agent context receipt is immutable once recorded".to_string(),
            ));
        }
        for draft in drafts {
            transaction.execute(
                "INSERT INTO agent_turn_context_items(
                    context_item_id, turn_id, project_root, ordinal, source_kind,
                    source_id, source_revision, source_sha256, trust_class,
                    capacity_source, original_bytes, included_bytes,
                    estimated_tokens, disposition, reason_code
                 ) VALUES(
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15
                 )",
                params![
                    draft.context_item_id,
                    turn_id,
                    project_root,
                    draft.ordinal,
                    draft.source_kind,
                    draft.source_id,
                    draft.source_revision,
                    draft.source_sha256,
                    draft.trust_class,
                    draft.capacity_source,
                    draft.original_bytes,
                    draft.included_bytes,
                    draft.estimated_tokens,
                    draft.disposition,
                    draft.reason_code,
                ],
            )?;
        }
        let items = load_context_items(&transaction, project_root, turn_id)?;
        transaction.commit()?;
        Ok(items)
    }

    pub fn list_agent_turn_context_items(
        &self,
        project_root: &str,
        turn_id: &str,
    ) -> Result<Vec<AgentTurnContextItem>, StoreError> {
        validate_project_root(project_root)?;
        validate_identifier(turn_id, "turn_id")?;
        load_context_items(&self.connection, project_root, turn_id)
    }
}

fn validate_execution_draft(draft: &RuntimeExecutionDraft) -> Result<(), StoreError> {
    validate_project_root(&draft.project_root)?;
    validate_identifier(&draft.execution_id, "execution_id")?;
    if let Some(run_id) = draft.run_id.as_deref() {
        validate_identifier(run_id, "run_id")?;
    }
    validate_identifier(&draft.runtime_provider_id, "runtime_provider_id")?;
    validate_identifier(&draft.runtime_instance_id, "runtime_instance_id")?;
    validate_identifier(&draft.console_instance_id, "console_instance_id")?;
    if let Some(workspace_id) = draft.workspace_id.as_deref() {
        validate_identifier(workspace_id, "workspace_id")?;
    }
    if draft.runtime_activation_generation <= 0 {
        return Err(StoreError::Validation(
            "Runtime activation generation must be positive".to_string(),
        ));
    }
    if let Some(source_path) = draft.source_path.as_deref()
        && (source_path.is_empty()
            || source_path.len() > MAX_PATH_BYTES
            || source_path.contains('\0'))
    {
        return Err(StoreError::Validation(
            "Runtime source path is empty or out of bounds".to_string(),
        ));
    }
    if let Some(execution_mode) = draft.execution_mode.as_deref() {
        validate_label(execution_mode, "execution_mode")?;
    }
    if draft.document_version.is_some_and(|value| value < 0) {
        return Err(StoreError::Validation(
            "Runtime document version cannot be negative".to_string(),
        ));
    }
    if draft.submitted_code.trim().is_empty()
        || draft.submitted_code.len() > MAX_SUBMITTED_CODE_BYTES
    {
        return Err(StoreError::Validation(
            "Runtime submitted code must be non-empty and no larger than 1 MiB".to_string(),
        ));
    }
    Ok(())
}

fn execution_identity_matches(existing: &RuntimeExecution, draft: &RuntimeExecutionDraft) -> bool {
    existing.execution_id == draft.execution_id
        && existing.project_root == draft.project_root
        && existing.run_id == draft.run_id
        && existing.runtime_provider_id == draft.runtime_provider_id
        && existing.runtime_instance_id == draft.runtime_instance_id
        && existing.runtime_activation_generation == draft.runtime_activation_generation
        && existing.console_instance_id == draft.console_instance_id
        && existing.workspace_id == draft.workspace_id
        && existing.source_path == draft.source_path
        && existing.execution_mode == draft.execution_mode
        && existing.document_version == draft.document_version
        && existing.submitted_code == draft.submitted_code
}

fn prepare_outputs(drafts: &[RuntimeOutputDraft]) -> Result<Vec<PreparedOutput>, StoreError> {
    let mut prepared = Vec::new();
    let mut producer_slots = BTreeSet::new();
    for draft in drafts {
        if draft.producer_sequence < 0 || draft.projection_slot < 0 {
            return Err(StoreError::Validation(
                "Runtime output producer sequence and projection slot cannot be negative"
                    .to_string(),
            ));
        }
        validate_label(&draft.source_kind, "source_kind")?;
        if !matches!(
            draft.presentation_kind.as_str(),
            "stdout" | "value" | "message" | "warning" | "error" | "status" | "display_ref"
        ) {
            return Err(StoreError::Validation(
                "Runtime output presentation kind is unsupported".to_string(),
            ));
        }
        if let Some(media_type) = draft.media_type.as_deref()
            && (media_type.is_empty() || media_type.len() > 255 || media_type.contains('\0'))
        {
            return Err(StoreError::Validation(
                "Runtime output media type is empty or out of bounds".to_string(),
            ));
        }
        let pieces = prepare_payload(draft)?;
        for (offset, mut piece) in pieces.into_iter().enumerate() {
            piece.projection_slot = draft
                .projection_slot
                .checked_add(i64::try_from(offset).map_err(|_| {
                    StoreError::Validation("Runtime output has too many split chunks".to_string())
                })?)
                .ok_or_else(|| {
                    StoreError::Validation("Runtime output projection slot overflow".to_string())
                })?;
            if !producer_slots.insert((piece.producer_sequence, piece.projection_slot)) {
                return Err(StoreError::Validation(
                    "Runtime output batch contains duplicate producer identities".to_string(),
                ));
            }
            prepared.push(piece);
            if prepared.len() > MAX_APPEND_CHUNKS {
                return Err(StoreError::Validation(
                    "Runtime output append exceeds 1024 chunks; stream smaller batches".to_string(),
                ));
            }
        }
    }
    Ok(prepared)
}

fn prepare_payload(draft: &RuntimeOutputDraft) -> Result<Vec<PreparedOutput>, StoreError> {
    let make = |storage_kind: &str,
                text_payload: Option<String>,
                json_payload: Option<String>,
                reference_kind: Option<String>,
                reference_id: Option<String>,
                bytes: &[u8]| {
        PreparedOutput {
            producer_sequence: draft.producer_sequence,
            projection_slot: draft.projection_slot,
            source_kind: draft.source_kind.clone(),
            presentation_kind: draft.presentation_kind.clone(),
            media_type: draft.media_type.clone(),
            storage_kind: storage_kind.to_string(),
            text_payload,
            json_payload,
            reference_kind,
            reference_id,
            payload_bytes: i64::try_from(bytes.len()).unwrap_or(i64::MAX),
            payload_sha256: sha256_hex(bytes),
        }
    };
    match &draft.payload {
        RuntimeOutputPayload::InlineText { text } => {
            if text.is_empty() {
                return Err(StoreError::Validation(
                    "Runtime inline text output cannot be empty".to_string(),
                ));
            }
            Ok(split_utf8(text, MAX_INLINE_CHUNK_BYTES)
                .into_iter()
                .map(|piece| {
                    let bytes = piece.as_bytes();
                    make("inline_text", Some(piece.clone()), None, None, None, bytes)
                })
                .collect())
        }
        RuntimeOutputPayload::InlineJson { json } => {
            validate_json_payload(json, "Runtime inline JSON")?;
            if json.len() > MAX_INLINE_CHUNK_BYTES {
                return Err(StoreError::Validation(
                    "Runtime inline JSON exceeds 64 KiB; store a typed record reference"
                        .to_string(),
                ));
            }
            Ok(vec![make(
                "inline_json",
                None,
                Some(json.clone()),
                None,
                None,
                json.as_bytes(),
            )])
        }
        RuntimeOutputPayload::RecordRef {
            reference_kind,
            reference_id,
            payload_bytes,
            payload_sha256,
        } => {
            if draft.presentation_kind != "display_ref" {
                return Err(StoreError::Validation(
                    "Runtime record references require display_ref presentation".to_string(),
                ));
            }
            if !matches!(reference_kind.as_str(), "plot" | "artifact") {
                return Err(StoreError::Validation(
                    "Runtime record reference kind is unsupported".to_string(),
                ));
            }
            validate_identifier(reference_id, "reference_id")?;
            if *payload_bytes < 0 {
                return Err(StoreError::Validation(
                    "Runtime record reference byte size cannot be negative".to_string(),
                ));
            }
            validate_sha256(payload_sha256, "record_ref.payload_sha256")?;
            let identity = format!("{reference_kind}\0{reference_id}");
            let mut prepared = make(
                "record_ref",
                None,
                None,
                Some(reference_kind.clone()),
                Some(reference_id.clone()),
                identity.as_bytes(),
            );
            prepared.payload_bytes = *payload_bytes;
            prepared.payload_sha256 = payload_sha256.clone();
            Ok(vec![prepared])
        }
        RuntimeOutputPayload::Tombstone { metadata_json } => {
            if draft.presentation_kind != "status" {
                return Err(StoreError::Validation(
                    "Runtime tombstones require status presentation".to_string(),
                ));
            }
            validate_json_payload(metadata_json, "Runtime tombstone metadata")?;
            if metadata_json.len() > MAX_INLINE_CHUNK_BYTES {
                return Err(StoreError::Validation(
                    "Runtime tombstone metadata exceeds 64 KiB".to_string(),
                ));
            }
            Ok(vec![make(
                "tombstone",
                None,
                Some(metadata_json.clone()),
                None,
                None,
                metadata_json.as_bytes(),
            )])
        }
    }
}

fn capture_tombstone(
    dropped: &PreparedOutput,
    captured_bytes: i64,
) -> Result<PreparedOutput, StoreError> {
    let metadata_json = serde_json::to_string(&serde_json::json!({
        "reason": "capture_limit_reached",
        "captured_bytes": captured_bytes,
        "first_dropped_payload_bytes": dropped.payload_bytes,
    }))?;
    Ok(PreparedOutput {
        producer_sequence: dropped.producer_sequence,
        projection_slot: dropped.projection_slot,
        source_kind: "host".to_string(),
        presentation_kind: "status".to_string(),
        media_type: Some("application/json".to_string()),
        storage_kind: "tombstone".to_string(),
        text_payload: None,
        json_payload: Some(metadata_json.clone()),
        reference_kind: None,
        reference_id: None,
        payload_bytes: i64::try_from(metadata_json.len()).unwrap_or(i64::MAX),
        payload_sha256: sha256_hex(metadata_json.as_bytes()),
    })
}

fn validate_record_reference(
    connection: &rusqlite::Connection,
    project_root: &str,
    output: &PreparedOutput,
) -> Result<(), StoreError> {
    if output.storage_kind != "record_ref" {
        return Ok(());
    }
    let reference_kind = output.reference_kind.as_deref().unwrap_or_default();
    let reference_id = output.reference_id.as_deref().unwrap_or_default();
    let exists = match reference_kind {
        "plot" => connection
            .query_row(
                "SELECT 1 FROM plot_artifacts WHERE project_root = ?1 AND plot_id = ?2",
                params![project_root, reference_id],
                |_row| Ok(()),
            )
            .optional()?
            .is_some(),
        "artifact" => connection
            .query_row(
                "SELECT 1 FROM artifact_records WHERE project_root = ?1 AND artifact_id = ?2",
                params![project_root, reference_id],
                |_row| Ok(()),
            )
            .optional()?
            .is_some(),
        _ => false,
    };
    if exists {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "Runtime output reference is unavailable in the active project".to_string(),
        ))
    }
}

fn insert_chunk(
    transaction: &rusqlite::Transaction<'_>,
    project_root: &str,
    execution_id: &str,
    sequence: i64,
    output: &PreparedOutput,
) -> Result<RuntimeOutputChunk, StoreError> {
    let created_at = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO runtime_output_chunks(
            execution_id, project_root, sequence, producer_sequence,
            projection_slot, source_kind, presentation_kind, media_type,
            storage_kind, text_payload, json_payload, reference_kind,
            reference_id, payload_bytes, payload_sha256, created_at
         ) VALUES(
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16
         )",
        params![
            execution_id,
            project_root,
            sequence,
            output.producer_sequence,
            output.projection_slot,
            output.source_kind,
            output.presentation_kind,
            output.media_type,
            output.storage_kind,
            output.text_payload,
            output.json_payload,
            output.reference_kind,
            output.reference_id,
            output.payload_bytes,
            output.payload_sha256,
            created_at,
        ],
    )?;
    Ok(RuntimeOutputChunk {
        execution_id: execution_id.to_string(),
        project_root: project_root.to_string(),
        sequence,
        producer_sequence: output.producer_sequence,
        projection_slot: output.projection_slot,
        source_kind: output.source_kind.clone(),
        presentation_kind: output.presentation_kind.clone(),
        media_type: output.media_type.clone(),
        storage_kind: output.storage_kind.clone(),
        text_payload: output.text_payload.clone(),
        json_payload: output.json_payload.clone(),
        reference_kind: output.reference_kind.clone(),
        reference_id: output.reference_id.clone(),
        payload_bytes: output.payload_bytes,
        payload_sha256: output.payload_sha256.clone(),
        created_at,
    })
}

fn load_chunk_by_producer(
    connection: &rusqlite::Connection,
    project_root: &str,
    execution_id: &str,
    producer_sequence: i64,
    projection_slot: i64,
) -> Result<Option<RuntimeOutputChunk>, StoreError> {
    connection
        .query_row(
            "SELECT execution_id, project_root, sequence, producer_sequence,
                    projection_slot, source_kind, presentation_kind, media_type,
                    storage_kind, text_payload, json_payload, reference_kind,
                    reference_id, payload_bytes, payload_sha256, created_at
             FROM runtime_output_chunks
             WHERE project_root = ?1 AND execution_id = ?2
               AND producer_sequence = ?3 AND projection_slot = ?4",
            params![
                project_root,
                execution_id,
                producer_sequence,
                projection_slot
            ],
            decode_chunk,
        )
        .optional()
        .map_err(StoreError::from)
}

fn prepared_matches_chunk(output: &PreparedOutput, chunk: &RuntimeOutputChunk) -> bool {
    output.producer_sequence == chunk.producer_sequence
        && output.projection_slot == chunk.projection_slot
        && output.source_kind == chunk.source_kind
        && output.presentation_kind == chunk.presentation_kind
        && output.media_type == chunk.media_type
        && output.storage_kind == chunk.storage_kind
        && output.text_payload == chunk.text_payload
        && output.json_payload == chunk.json_payload
        && output.reference_kind == chunk.reference_kind
        && output.reference_id == chunk.reference_id
        && output.payload_bytes == chunk.payload_bytes
        && output.payload_sha256 == chunk.payload_sha256
}

fn load_runtime_output_policy(
    connection: &rusqlite::Connection,
    project_root: &str,
) -> Result<RuntimeOutputPolicy, StoreError> {
    let stored = connection
        .query_row(
            "SELECT project_root, revision, max_runtime_output_bytes_per_execution,
                    runtime_output_project_warning_bytes, max_runtime_execution_rows,
                    auto_prune_enabled, updated_at
             FROM project_runtime_output_policies WHERE project_root = ?1",
            params![project_root],
            |row| {
                Ok(RuntimeOutputPolicy {
                    project_root: row.get(0)?,
                    revision: row.get(1)?,
                    max_runtime_output_bytes_per_execution: row.get(2)?,
                    runtime_output_project_warning_bytes: row.get(3)?,
                    max_runtime_execution_rows: row.get(4)?,
                    auto_prune_enabled: row.get::<_, i64>(5)? != 0,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(stored.unwrap_or_else(|| RuntimeOutputPolicy {
        project_root: project_root.to_string(),
        revision: 0,
        max_runtime_output_bytes_per_execution: Some(128 * 1024 * 1024),
        runtime_output_project_warning_bytes: Some(1024 * 1024 * 1024),
        max_runtime_execution_rows: Some(5_000),
        auto_prune_enabled: false,
        updated_at: String::new(),
    }))
}

fn validate_runtime_output_policy_values(
    max_execution_bytes: Option<i64>,
    project_warning_bytes: Option<i64>,
    max_execution_rows: Option<i64>,
    auto_prune_enabled: bool,
) -> Result<(), StoreError> {
    if max_execution_bytes.is_some_and(|value| value < 0)
        || project_warning_bytes.is_some_and(|value| value < 0)
        || max_execution_rows.is_some_and(|value| value <= 0)
    {
        return Err(StoreError::Validation(
            "Runtime output policy values are out of bounds".to_string(),
        ));
    }
    if auto_prune_enabled {
        return Err(StoreError::Validation(
            "Automatic Runtime output pruning is not enabled by this contract".to_string(),
        ));
    }
    Ok(())
}

fn load_execution(
    connection: &rusqlite::Connection,
    project_root: &str,
    execution_id: &str,
) -> Result<Option<RuntimeExecution>, StoreError> {
    connection
        .query_row(
            "SELECT execution_id, project_root, run_id, runtime_provider_id,
                    runtime_instance_id, runtime_activation_generation,
                    console_instance_id, workspace_id, source_path, execution_mode,
                    document_version, submitted_code, status, terminal_reason, output_state,
                    last_sequence, output_bytes, started_at, finished_at
             FROM runtime_executions
             WHERE project_root = ?1 AND execution_id = ?2",
            params![project_root, execution_id],
            decode_execution,
        )
        .optional()
        .map_err(StoreError::from)
}

fn decode_execution(row: &Row<'_>) -> rusqlite::Result<RuntimeExecution> {
    Ok(RuntimeExecution {
        execution_id: row.get(0)?,
        project_root: row.get(1)?,
        run_id: row.get(2)?,
        runtime_provider_id: row.get(3)?,
        runtime_instance_id: row.get(4)?,
        runtime_activation_generation: row.get(5)?,
        console_instance_id: row.get(6)?,
        workspace_id: row.get(7)?,
        source_path: row.get(8)?,
        execution_mode: row.get(9)?,
        document_version: row.get(10)?,
        submitted_code: row.get(11)?,
        status: row.get(12)?,
        terminal_reason: row.get(13)?,
        output_state: row.get(14)?,
        last_sequence: row.get(15)?,
        output_bytes: row.get(16)?,
        started_at: row.get(17)?,
        finished_at: row.get(18)?,
    })
}

fn decode_chunk(row: &Row<'_>) -> rusqlite::Result<RuntimeOutputChunk> {
    Ok(RuntimeOutputChunk {
        execution_id: row.get(0)?,
        project_root: row.get(1)?,
        sequence: row.get(2)?,
        producer_sequence: row.get(3)?,
        projection_slot: row.get(4)?,
        source_kind: row.get(5)?,
        presentation_kind: row.get(6)?,
        media_type: row.get(7)?,
        storage_kind: row.get(8)?,
        text_payload: row.get(9)?,
        json_payload: row.get(10)?,
        reference_kind: row.get(11)?,
        reference_id: row.get(12)?,
        payload_bytes: row.get(13)?,
        payload_sha256: row.get(14)?,
        created_at: row.get(15)?,
    })
}

fn load_context_items(
    connection: &rusqlite::Connection,
    project_root: &str,
    turn_id: &str,
) -> Result<Vec<AgentTurnContextItem>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT context_item_id, turn_id, project_root, ordinal, source_kind,
                source_id, source_revision, source_sha256, trust_class,
                capacity_source, original_bytes, included_bytes,
                estimated_tokens, disposition, reason_code
         FROM agent_turn_context_items
         WHERE project_root = ?1 AND turn_id = ?2
         ORDER BY ordinal ASC",
    )?;
    let items = statement
        .query_map(params![project_root, turn_id], decode_context_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

fn decode_context_item(row: &Row<'_>) -> rusqlite::Result<AgentTurnContextItem> {
    Ok(AgentTurnContextItem {
        context_item_id: row.get(0)?,
        turn_id: row.get(1)?,
        project_root: row.get(2)?,
        ordinal: row.get(3)?,
        source_kind: row.get(4)?,
        source_id: row.get(5)?,
        source_revision: row.get(6)?,
        source_sha256: row.get(7)?,
        trust_class: row.get(8)?,
        capacity_source: row.get(9)?,
        original_bytes: row.get(10)?,
        included_bytes: row.get(11)?,
        estimated_tokens: row.get(12)?,
        disposition: row.get(13)?,
        reason_code: row.get(14)?,
    })
}

fn validate_context_items(drafts: &[AgentTurnContextItemDraft]) -> Result<(), StoreError> {
    let mut ids = BTreeSet::new();
    let mut ordinals = BTreeSet::new();
    for draft in drafts {
        validate_identifier(&draft.context_item_id, "context_item_id")?;
        if draft.ordinal < 0
            || !ids.insert(draft.context_item_id.as_str())
            || !ordinals.insert(draft.ordinal)
        {
            return Err(StoreError::Validation(
                "Agent context receipt contains invalid or duplicate identity".to_string(),
            ));
        }
        validate_label(&draft.source_kind, "source_kind")?;
        validate_optional_text(draft.source_id.as_deref(), 512, "source_id")?;
        validate_optional_text(draft.source_revision.as_deref(), 512, "source_revision")?;
        validate_sha256(&draft.source_sha256, "source_sha256")?;
        validate_label(&draft.trust_class, "trust_class")?;
        if !matches!(
            draft.capacity_source.as_str(),
            "catalog" | "user" | "conservative"
        ) {
            return Err(StoreError::Validation(
                "Agent context capacity source is unsupported".to_string(),
            ));
        }
        if draft.original_bytes < 0
            || draft.included_bytes < 0
            || draft.included_bytes > draft.original_bytes
            || draft.estimated_tokens < 0
        {
            return Err(StoreError::Validation(
                "Agent context receipt byte/token accounting is invalid".to_string(),
            ));
        }
        if !matches!(
            draft.disposition.as_str(),
            "complete" | "projected" | "truncated" | "omitted" | "unavailable" | "rejected"
        ) {
            return Err(StoreError::Validation(
                "Agent context disposition is unsupported".to_string(),
            ));
        }
        validate_optional_text(draft.reason_code.as_deref(), 128, "reason_code")?;
    }
    Ok(())
}

fn validate_project_root(project_root: &str) -> Result<(), StoreError> {
    if project_root.is_empty() || normalize_project_root(project_root) != project_root {
        return Err(StoreError::Validation(
            "project root must be non-empty and normalized".to_string(),
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(StoreError::Validation(format!(
            "{label} is empty, malformed, or out of bounds"
        )));
    }
    Ok(())
}

fn validate_label(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > MAX_LABEL_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(StoreError::Validation(format!(
            "{label} is empty, malformed, or out of bounds"
        )));
    }
    Ok(())
}

fn validate_optional_text(
    value: Option<&str>,
    max_bytes: usize,
    label: &str,
) -> Result<(), StoreError> {
    if value.is_some_and(|value| value.len() > max_bytes || value.contains('\0')) {
        return Err(StoreError::Validation(format!(
            "{label} is malformed or out of bounds"
        )));
    }
    Ok(())
}

fn validate_json_payload(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty() || serde_json::from_str::<serde_json::Value>(value).is_err() {
        return Err(StoreError::Validation(format!(
            "{label} must be valid JSON"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<(), StoreError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StoreError::Validation(format!(
            "{label} must be lowercase SHA-256"
        )));
    }
    Ok(())
}

fn split_utf8(value: &str, max_bytes: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = start.saturating_add(max_bytes).min(value.len());
        while end > start && !value.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(value[start..end].to_string());
        start = end;
    }
    chunks
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rusqlite::Connection;
    use tempfile::TempDir;

    use super::*;
    use crate::{
        AgentTurnDraft, MigrationStatus, RunDraft, SCHEMA_VERSION, StoreOpenOptions,
        migration::{assert_runtime_output_schema, read_schema_version, set_schema_version},
    };

    fn execution(project_root: &str) -> RuntimeExecutionDraft {
        RuntimeExecutionDraft {
            execution_id: "execution.shared".to_string(),
            project_root: project_root.to_string(),
            run_id: None,
            runtime_provider_id: "workspace-r".to_string(),
            runtime_instance_id: format!("runtime.{project_root}"),
            runtime_activation_generation: 1,
            console_instance_id: "console.main".to_string(),
            submitted_code: "1 + 1".to_string(),
            workspace_id: Some(format!("workspace.{project_root}")),
            source_path: Some("analysis.R".to_string()),
            execution_mode: Some("source_expression".to_string()),
            document_version: Some(1),
        }
    }

    fn text_output(producer_sequence: i64, text: &str) -> RuntimeOutputDraft {
        RuntimeOutputDraft {
            producer_sequence,
            projection_slot: 0,
            source_kind: "workspace_kernel".to_string(),
            presentation_kind: "stdout".to_string(),
            media_type: Some("text/plain".to_string()),
            payload: RuntimeOutputPayload::InlineText {
                text: text.to_string(),
            },
        }
    }

    fn create_v14_fixture(path: &Path) {
        let store = Store::open(path).unwrap();
        store
            .connection
            .execute_batch(
                "DROP TABLE agent_turn_context_items;
                 DROP TABLE project_runtime_output_policies;
                 DROP TABLE runtime_output_chunks;
                 DROP TABLE runtime_executions;
                 DROP INDEX IF EXISTS idx_agent_turn_context_project_turn;
                 DROP INDEX IF EXISTS idx_runtime_output_project_execution_sequence;
                 DROP INDEX IF EXISTS idx_runtime_executions_workspace_started;
                 DROP INDEX IF EXISTS idx_runtime_executions_console_started;
                 DROP INDEX IF EXISTS idx_runtime_executions_project_started;
                 DROP INDEX IF EXISTS idx_agent_turns_id_project;
                 DROP INDEX IF EXISTS idx_runs_id_project;",
            )
            .unwrap();
        set_schema_version(&store.connection, 14).unwrap();
    }

    #[test]
    fn migrates_v14_to_v15_with_backup_and_reopens_idempotently() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v14_fixture(&database);

        let store = Store::open(&database).unwrap();
        assert_eq!(store.migration_outcome().status, MigrationStatus::Migrated);
        assert_eq!(store.migration_outcome().from_schema_version, Some(14));
        assert_eq!(
            store.migration_outcome().to_schema_version,
            Some(SCHEMA_VERSION)
        );
        assert!(
            store
                .migration_outcome()
                .backup_path
                .as_deref()
                .unwrap()
                .ends_with("rho.sqlite.schema-v14.bak")
        );
        assert_runtime_output_schema(&store.connection).unwrap();
        drop(store);
        assert_eq!(
            Store::open(&database).unwrap().migration_outcome().status,
            MigrationStatus::OpenedCurrent
        );
    }

    #[test]
    fn rolls_back_v14_migration_failure_and_recovers() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v14_fixture(&database);

        let error = Store::open_with_options(
            &database,
            StoreOpenOptions {
                inject_v14_failure_before_commit: true,
                ..Default::default()
            },
        )
        .unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.from_schema_version, Some(14));
        assert_eq!(outcome.reason_code.as_deref(), Some("injected_failure"));
        assert!(Path::new(outcome.backup_path.as_deref().unwrap()).exists());
        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(14));
        assert!(
            verification
                .prepare("SELECT * FROM runtime_executions")
                .is_err()
        );
        drop(verification);
        assert_eq!(
            Store::open(&database)
                .unwrap()
                .migration_outcome()
                .to_schema_version,
            Some(SCHEMA_VERSION)
        );
    }

    #[test]
    fn output_journal_splits_deduplicates_pages_and_isolates_projects() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        store
            .create_runtime_execution(&execution("D:/projects/A"))
            .unwrap();
        store
            .create_runtime_execution(&execution("D:/projects/B"))
            .unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run.a".to_string(),
                parent_run_id: None,
                project_root: "D:/projects/A".to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "execute".to_string(),
                code: "1 + 1".to_string(),
                arguments_json: "{}".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("source_expression".to_string()),
                document_version: Some(1),
                workspace_id: "workspace.a".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        assert_eq!(
            store
                .link_runtime_execution_run("D:/projects/A", "execution.shared", "run.a")
                .unwrap(),
            RuntimeExecutionMutationOutcome::Applied
        );
        assert!(
            store
                .link_runtime_execution_run("D:/projects/B", "execution.shared", "run.a")
                .is_err()
        );
        assert_eq!(
            store
                .mark_runtime_execution_running("D:/projects/A", "execution.shared")
                .unwrap(),
            RuntimeExecutionMutationOutcome::Applied
        );
        let long_text = format!("{}尾", "a".repeat(MAX_INLINE_CHUNK_BYTES));
        let appended = store
            .append_runtime_output(
                "D:/projects/A",
                "execution.shared",
                &[text_output(1, &long_text)],
                None,
            )
            .unwrap();
        assert_eq!(appended.committed.len(), 2);
        assert_eq!(
            appended.committed[0].payload_bytes,
            MAX_INLINE_CHUNK_BYTES as i64
        );
        assert_eq!(appended.committed[1].text_payload.as_deref(), Some("尾"));
        let duplicate = store
            .append_runtime_output(
                "D:/projects/A",
                "execution.shared",
                &[text_output(1, &long_text)],
                None,
            )
            .unwrap();
        assert_eq!(duplicate.duplicate_count, 2);
        assert!(duplicate.committed.is_empty());

        let first_page = store
            .runtime_output_page("D:/projects/A", "execution.shared", 0, 1, MIN_PAGE_BYTES)
            .unwrap();
        assert_eq!(first_page.chunks.len(), 1);
        assert!(first_page.has_more);
        let second_page = store
            .runtime_output_page(
                "D:/projects/A",
                "execution.shared",
                first_page.next_sequence,
                10,
                MAX_PAGE_BYTES,
            )
            .unwrap();
        assert_eq!(second_page.chunks.len(), 1);
        assert!(!second_page.has_more);

        let tail_page = store
            .runtime_output_page_before(
                "D:/projects/A",
                "execution.shared",
                second_page.next_sequence + 1,
                1,
                MIN_PAGE_BYTES,
            )
            .unwrap();
        assert_eq!(tail_page.chunks[0].sequence, 2);
        assert!(tail_page.has_older);
        assert!(!tail_page.has_more);
        let older_page = store
            .runtime_output_page_before(
                "D:/projects/A",
                "execution.shared",
                tail_page.previous_sequence,
                1,
                MIN_PAGE_BYTES,
            )
            .unwrap();
        assert_eq!(older_page.chunks[0].sequence, 1);
        assert!(!older_page.has_older);
        assert!(older_page.has_more);

        let search = store
            .search_runtime_output("D:/projects/A", "尾", Some("console.main"), None, 10)
            .unwrap();
        assert_eq!(search.searched_execution_count, 1);
        assert_eq!(search.matched_execution_count, 1);
        assert_eq!(search.hits[0].sequence, 2);
        assert_eq!(search.hits[0].preview, "尾");
        assert_eq!(search.hits[0].payload_sha256.len(), 64);
        assert!(
            store
                .search_runtime_output("D:/projects/B", "尾", Some("console.main"), None, 10)
                .unwrap()
                .hits
                .is_empty()
        );
        let code_search = store
            .search_runtime_output("D:/projects/A", "1 + 1", None, None, 10)
            .unwrap();
        assert_eq!(code_search.hits[0].sequence, 0);
        assert_eq!(code_search.hits[0].payload_sha256.len(), 64);

        let first_execution_page = store
            .list_runtime_executions_before("D:/projects/A", Some(1), None)
            .unwrap();
        assert_eq!(first_execution_page.len(), 1);
        let no_older_execution = store
            .list_runtime_executions_before(
                "D:/projects/A",
                Some(1),
                Some((
                    &first_execution_page[0].started_at,
                    &first_execution_page[0].execution_id,
                )),
            )
            .unwrap();
        assert!(no_older_execution.is_empty());

        let project_b = store
            .runtime_output_page("D:/projects/B", "execution.shared", 0, 10, MAX_PAGE_BYTES)
            .unwrap();
        assert!(project_b.chunks.is_empty());
        assert_eq!(project_b.total_output_bytes, 0);

        let summary = store
            .project_retention_summary("D:/projects/A", Some("workspace.D:/projects/A"))
            .unwrap();
        assert_eq!(summary.session.runtime_execution_count, 1);
        assert_eq!(
            summary.session.runtime_inline_output_bytes,
            long_text.len() as i64
        );
        assert_eq!(summary.session.runtime_tombstone_count, 0);
        assert_eq!(summary.project.runtime_execution_count, 1);
    }

    #[test]
    fn capture_limit_records_one_tombstone_and_preserves_terminal_outcome() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        store
            .create_runtime_execution(&execution("D:/projects/A"))
            .unwrap();
        let result = store
            .append_runtime_output(
                "D:/projects/A",
                "execution.shared",
                &[text_output(1, "too large")],
                Some(1),
            )
            .unwrap();
        assert!(result.capture_stopped);
        assert_eq!(result.committed.len(), 1);
        assert_eq!(result.committed[0].storage_kind, "tombstone");
        assert_eq!(
            store
                .finish_runtime_execution(
                    "D:/projects/A",
                    "execution.shared",
                    &RuntimeExecutionFinish {
                        status: "completed".to_string(),
                        terminal_reason: None,
                        output_state: "complete".to_string(),
                    },
                )
                .unwrap(),
            RuntimeExecutionMutationOutcome::Applied
        );
        let execution = store
            .get_runtime_execution("D:/projects/A", "execution.shared")
            .unwrap()
            .unwrap();
        assert_eq!(execution.status, "completed");
        assert_eq!(execution.output_state, "partial");
    }

    #[test]
    fn runtime_output_policy_is_project_isolated_revisioned_and_recovers_after_rejection() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let default_a = store.get_runtime_output_policy("D:/projects/A").unwrap();
        let default_b = store.get_runtime_output_policy("D:/projects/B").unwrap();
        assert_eq!(default_a.revision, 0);
        assert_eq!(
            default_a.max_runtime_output_bytes_per_execution,
            Some(128 * 1024 * 1024)
        );
        assert_eq!(
            default_b,
            RuntimeOutputPolicy {
                project_root: "D:/projects/B".to_string(),
                ..default_a.clone()
            }
        );

        let updated = store
            .update_runtime_output_policy(
                "D:/projects/A",
                &RuntimeOutputPolicyUpdate {
                    expected_revision: 0,
                    max_runtime_output_bytes_per_execution: None,
                    runtime_output_project_warning_bytes: Some(512 * 1024 * 1024),
                    max_runtime_execution_rows: Some(10_000),
                    auto_prune_enabled: false,
                },
            )
            .unwrap();
        assert_eq!(updated.revision, 1);
        assert_eq!(updated.max_runtime_output_bytes_per_execution, None);
        assert_eq!(
            store
                .get_runtime_output_policy("D:/projects/B")
                .unwrap()
                .revision,
            0
        );

        let stale = store
            .update_runtime_output_policy(
                "D:/projects/A",
                &RuntimeOutputPolicyUpdate {
                    expected_revision: 0,
                    max_runtime_output_bytes_per_execution: Some(1),
                    runtime_output_project_warning_bytes: Some(1),
                    max_runtime_execution_rows: Some(1),
                    auto_prune_enabled: false,
                },
            )
            .unwrap_err();
        assert!(stale.to_string().contains("changed"));

        let rejected = store
            .update_runtime_output_policy(
                "D:/projects/A",
                &RuntimeOutputPolicyUpdate {
                    expected_revision: 1,
                    max_runtime_output_bytes_per_execution: Some(-1),
                    runtime_output_project_warning_bytes: Some(1),
                    max_runtime_execution_rows: Some(1),
                    auto_prune_enabled: true,
                },
            )
            .unwrap_err();
        assert!(rejected.to_string().contains("out of bounds"));
        assert_eq!(
            store.get_runtime_output_policy("D:/projects/A").unwrap(),
            updated
        );

        let recovered = store
            .update_runtime_output_policy(
                "D:/projects/A",
                &RuntimeOutputPolicyUpdate {
                    expected_revision: 1,
                    max_runtime_output_bytes_per_execution: Some(256 * 1024 * 1024),
                    runtime_output_project_warning_bytes: None,
                    max_runtime_execution_rows: None,
                    auto_prune_enabled: false,
                },
            )
            .unwrap();
        assert_eq!(recovered.revision, 2);
        drop(store);
        assert_eq!(
            Store::open(&database)
                .unwrap()
                .get_runtime_output_policy("D:/projects/A")
                .unwrap(),
            recovered
        );
    }

    #[test]
    fn manual_prune_keeps_ordered_tombstones_and_delete_respects_context_and_project_scope() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        for root in ["D:/projects/A", "D:/projects/B"] {
            store.create_runtime_execution(&execution(root)).unwrap();
            store
                .append_runtime_output(
                    root,
                    "execution.shared",
                    &[
                        text_output(1, &"alpha".repeat(8_000)),
                        text_output(2, &"beta".repeat(8_000)),
                    ],
                    None,
                )
                .unwrap();
            store
                .finish_runtime_execution(
                    root,
                    "execution.shared",
                    &RuntimeExecutionFinish {
                        status: "completed".to_string(),
                        terminal_reason: None,
                        output_state: "complete".to_string(),
                    },
                )
                .unwrap();
        }

        let pruned = store
            .prune_runtime_output_payloads("D:/projects/A", "execution.shared")
            .unwrap();
        assert_eq!(pruned.outcome, RuntimeExecutionMutationOutcome::Applied);
        assert_eq!(pruned.pruned_chunk_count, 2);
        assert!(pruned.reclaimed_bytes > 0);
        let page = store
            .runtime_output_page("D:/projects/A", "execution.shared", 0, 10, MAX_PAGE_BYTES)
            .unwrap();
        assert_eq!(
            page.chunks
                .iter()
                .map(|chunk| chunk.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(
            page.chunks
                .iter()
                .all(|chunk| chunk.storage_kind == "tombstone")
        );
        assert_eq!(page.output_state, "pruned");
        assert_eq!(
            store
                .prune_runtime_output_payloads("D:/projects/A", "execution.shared")
                .unwrap()
                .outcome,
            RuntimeExecutionMutationOutcome::Unchanged
        );
        assert_eq!(
            store
                .runtime_output_page("D:/projects/B", "execution.shared", 0, 10, MAX_PAGE_BYTES,)
                .unwrap()
                .chunks[0]
                .storage_kind,
            "inline_text"
        );

        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: "turn.prune".to_string(),
                project_root: "D:/projects/A".to_string(),
                mode: "ask".to_string(),
                prompt: "review output".to_string(),
                model: "fake".to_string(),
                workspace_id: "workspace.a".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
            })
            .unwrap();
        store
            .record_agent_turn_context_items(
                "D:/projects/A",
                "turn.prune",
                &[AgentTurnContextItemDraft {
                    context_item_id: "context.prune".to_string(),
                    ordinal: 0,
                    source_kind: "runtime_output".to_string(),
                    source_id: Some("execution.shared:1-2".to_string()),
                    source_revision: Some("2".to_string()),
                    source_sha256: "a".repeat(64),
                    trust_class: "explicit_project_data".to_string(),
                    capacity_source: "catalog".to_string(),
                    original_bytes: 10,
                    included_bytes: 10,
                    estimated_tokens: 3,
                    disposition: "complete".to_string(),
                    reason_code: None,
                }],
            )
            .unwrap();
        assert!(
            store
                .delete_runtime_execution_record("D:/projects/A", "execution.shared")
                .unwrap_err()
                .to_string()
                .contains("Agent context receipt")
        );
        let deleted = store
            .delete_runtime_execution_record("D:/projects/B", "execution.shared")
            .unwrap();
        assert_eq!(deleted.outcome, RuntimeExecutionMutationOutcome::Applied);
        assert_eq!(deleted.deleted_output_chunk_count, 2);
        assert!(
            store
                .get_runtime_execution("D:/projects/B", "execution.shared")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .get_runtime_execution("D:/projects/A", "execution.shared")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn restart_reconciliation_fails_only_active_project_rows_and_preserves_committed_output() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        for root in ["D:/projects/A", "D:/projects/B"] {
            store.create_runtime_execution(&execution(root)).unwrap();
        }
        store
            .mark_runtime_execution_running("D:/projects/A", "execution.shared")
            .unwrap();
        store
            .append_runtime_output(
                "D:/projects/A",
                "execution.shared",
                &[text_output(1, "committed before restart")],
                None,
            )
            .unwrap();

        assert_eq!(
            store
                .reconcile_interrupted_runtime_executions("D:/projects/A")
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .reconcile_interrupted_runtime_executions("D:/projects/A")
                .unwrap(),
            0
        );
        let recovered = store
            .get_runtime_execution("D:/projects/A", "execution.shared")
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, "failed");
        assert_eq!(recovered.output_state, "partial");
        assert_eq!(recovered.last_sequence, 2);
        assert!(recovered.terminal_reason.unwrap().contains("restarted"));
        let page = store
            .runtime_output_page("D:/projects/A", "execution.shared", 0, 10, MAX_PAGE_BYTES)
            .unwrap();
        assert_eq!(
            page.chunks[0].text_payload.as_deref(),
            Some("committed before restart")
        );
        assert_eq!(page.chunks[1].storage_kind, "tombstone");

        let other = store
            .get_runtime_execution("D:/projects/B", "execution.shared")
            .unwrap()
            .unwrap();
        assert_eq!(other.status, "admitted");
    }

    #[test]
    fn context_receipts_are_immutable_and_project_scoped() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: "turn.a".to_string(),
                project_root: "D:/projects/A".to_string(),
                mode: "ask".to_string(),
                prompt: "inspect this output".to_string(),
                model: "fake".to_string(),
                workspace_id: "workspace.a".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
            })
            .unwrap();
        let draft = AgentTurnContextItemDraft {
            context_item_id: "context.a".to_string(),
            ordinal: 0,
            source_kind: "runtime_output".to_string(),
            source_id: Some("execution.shared:1-2".to_string()),
            source_revision: Some("2".to_string()),
            source_sha256: "a".repeat(64),
            trust_class: "explicit_project_data".to_string(),
            capacity_source: "catalog".to_string(),
            original_bytes: 100,
            included_bytes: 80,
            estimated_tokens: 20,
            disposition: "projected".to_string(),
            reason_code: None,
        };
        let items = store
            .record_agent_turn_context_items("D:/projects/A", "turn.a", &[draft.clone()])
            .unwrap();
        assert_eq!(items.len(), 1);
        assert!(
            store
                .list_agent_turn_context_items("D:/projects/B", "turn.a")
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .record_agent_turn_context_items("D:/projects/A", "turn.a", &[draft])
                .is_err()
        );
    }
}
