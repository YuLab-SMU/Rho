//! Durable P2-4 workspace-plugin lifecycle facts.
//!
//! This module stores desired/observed state and transition journals only. It
//! does not discover packages, copy files, activate Wasm, mint handles, route
//! contributions, or perform uninstall/upgrade mutations.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError, query::required_project_root};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;
const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_DETAILS_BYTES: usize = 8 * 1024;
const MAX_RETENTION_BATCH: usize = 100;

const TRANSITION_PHASES: &[&str] = &[
    "requested",
    "preflight",
    "backup_prepared",
    "grants_ready",
    "candidate_activated",
    "routing_closed",
    "calls_drained",
    "handles_revoked",
    "contributions_disposed",
    "host_disposed",
    "package_moved",
    "pointer_swapped",
    "durable_committed",
    "completed",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginDiscoveredDraft {
    pub project_root: String,
    pub plugin_id: String,
    pub directory_name: String,
    pub plugin_version: String,
    pub runtime_kind: String,
    pub discovered_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginState {
    pub project_root: String,
    pub plugin_id: String,
    pub directory_name: String,
    pub plugin_version: String,
    pub accepted_digest: Option<String>,
    pub pending_digest: Option<String>,
    pub rollback_digest: Option<String>,
    pub runtime_kind: String,
    pub desired_state: String,
    pub observed_state: String,
    pub last_activation_generation: i64,
    pub last_host_session_id: Option<String>,
    pub transition_id: Option<String>,
    pub last_error_code: Option<String>,
    pub enabled_at: Option<String>,
    pub disabled_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginTransitionDraft {
    pub transition_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub kind: String,
    pub request_event_type: String,
    pub desired_state: String,
    pub expected_old_digest: Option<String>,
    pub candidate_digest: Option<String>,
    pub rollback_digest: Option<String>,
    pub backup_path_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginTransition {
    pub transition_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub kind: String,
    pub expected_old_digest: Option<String>,
    pub candidate_digest: Option<String>,
    pub rollback_digest: Option<String>,
    pub phase: String,
    pub status: String,
    pub requested_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub reason_code: Option<String>,
    pub backup_path_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginTransitionAdvance {
    pub project_root: String,
    pub transition_id: String,
    pub expected_phase: String,
    pub next_phase: String,
    pub status: String,
    pub observed_state: String,
    pub accepted_digest: Option<String>,
    pub pending_digest: Option<String>,
    pub rollback_digest: Option<String>,
    pub clear_pending_digest: bool,
    pub last_host_session_id: Option<String>,
    pub last_error_code: Option<String>,
    pub reason_code: Option<String>,
    pub event_type: String,
    pub event_status: String,
    pub details_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginLifecycleEvent {
    pub event_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub transition_id: Option<String>,
    pub package_digest: Option<String>,
    pub event_type: String,
    pub status: String,
    pub phase: String,
    pub reason_code: Option<String>,
    pub details_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginTombstoneDraft {
    pub tombstone_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub backup_path_key: String,
    pub original_directory_name: String,
    pub retention_class: String,
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginPackageTombstone {
    pub tombstone_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub backup_path_key: String,
    pub original_directory_name: String,
    pub moved_at: String,
    pub deleted_at: Option<String>,
    pub restored_at: Option<String>,
    pub retention_class: String,
    pub reason_code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginLifecycleMutationOutcome {
    Applied,
    Unchanged,
    NotFound,
    Stale,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginTransitionRequestResult {
    pub outcome: PluginLifecycleMutationOutcome,
    pub state: WorkspacePluginState,
    pub transition: WorkspacePluginTransition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginGenerationAllocation {
    pub outcome: PluginLifecycleMutationOutcome,
    pub generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginCrashOutcome {
    pub outcome: PluginLifecycleMutationOutcome,
    pub crash_count: usize,
    pub blocked: bool,
    pub state: WorkspacePluginState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginUninstallCompletion {
    pub outcome: PluginLifecycleMutationOutcome,
    pub state: WorkspacePluginState,
    pub transition: WorkspacePluginTransition,
    pub tombstone: WorkspacePluginPackageTombstone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginRestoreCompletion {
    pub outcome: PluginLifecycleMutationOutcome,
    pub state: WorkspacePluginState,
    pub tombstone: WorkspacePluginPackageTombstone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginPurgeDraft {
    pub project_root: String,
    pub tombstone_id: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub backup_path_key: String,
    pub original_directory_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginRetentionSweep {
    pub outcome: PluginLifecycleMutationOutcome,
    pub expired: Vec<WorkspacePluginPackageTombstone>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePluginPurgeResult {
    pub outcome: PluginLifecycleMutationOutcome,
    pub tombstone: WorkspacePluginPackageTombstone,
}

impl Store {
    pub fn upsert_discovered_workspace_plugin(
        &mut self,
        draft: &WorkspacePluginDiscoveredDraft,
    ) -> Result<(PluginLifecycleMutationOutcome, WorkspacePluginState), StoreError> {
        let draft = validate_discovered(draft)?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = get_state_on(&transaction, &draft.project_root, &draft.plugin_id)?;
        let outcome = if let Some(existing) = &existing {
            if existing.directory_name == draft.directory_name
                && existing.plugin_version == draft.plugin_version
                && existing.runtime_kind == draft.runtime_kind
                && (existing.pending_digest.as_deref() == Some(&draft.discovered_digest)
                    || (existing.accepted_digest.as_deref() == Some(&draft.discovered_digest)
                        && existing.pending_digest.is_none()))
            {
                PluginLifecycleMutationOutcome::Unchanged
            } else {
                transaction.execute(
                    "UPDATE workspace_plugin_states
                     SET directory_name = ?3, plugin_version = ?4, runtime_kind = ?5,
                         pending_digest = CASE
                           WHEN accepted_digest = ?6 THEN NULL ELSE ?6
                         END,
                         observed_state = CASE
                           WHEN accepted_digest IS NULL THEN 'discovered'
                           WHEN accepted_digest <> ?6 THEN 'update_pending'
                           ELSE observed_state
                         END,
                         updated_at = ?7
                     WHERE project_root = ?1 AND plugin_id = ?2",
                    params![
                        draft.project_root,
                        draft.plugin_id,
                        draft.directory_name,
                        draft.plugin_version,
                        draft.runtime_kind,
                        draft.discovered_digest,
                        now,
                    ],
                )?;
                PluginLifecycleMutationOutcome::Applied
            }
        } else {
            transaction.execute(
                "INSERT INTO workspace_plugin_states(
                    project_root, plugin_id, directory_name, plugin_version,
                    accepted_digest, pending_digest, rollback_digest, runtime_kind,
                    desired_state, observed_state, last_activation_generation,
                    last_host_session_id, transition_id, last_error_code,
                    enabled_at, disabled_at, updated_at
                 ) VALUES(?1, ?2, ?3, ?4, NULL, ?5, NULL, ?6,
                          'disabled', 'discovered', 0, NULL, NULL, NULL, NULL, NULL, ?7)",
                params![
                    draft.project_root,
                    draft.plugin_id,
                    draft.directory_name,
                    draft.plugin_version,
                    draft.discovered_digest,
                    draft.runtime_kind,
                    now,
                ],
            )?;
            PluginLifecycleMutationOutcome::Applied
        };
        if outcome == PluginLifecycleMutationOutcome::Applied {
            insert_lifecycle_event(
                &transaction,
                LifecycleEventInsert {
                    project_root: &draft.project_root,
                    plugin_id: &draft.plugin_id,
                    transition_id: None,
                    package_digest: Some(&draft.discovered_digest),
                    event_type: "discovery",
                    status: "completed",
                    phase: "requested",
                    reason_code: None,
                    details_json: "{}",
                    created_at: &now,
                },
            )?;
        }
        let state = get_state_on(&transaction, &draft.project_root, &draft.plugin_id)?.ok_or_else(
            || StoreError::Validation("workspace plugin state disappeared".to_string()),
        )?;
        transaction.commit()?;
        Ok((outcome, state))
    }

    pub fn request_workspace_plugin_transition(
        &mut self,
        draft: &WorkspacePluginTransitionDraft,
    ) -> Result<WorkspacePluginTransitionRequestResult, StoreError> {
        let draft = validate_transition_draft(draft)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) =
            get_transition_on(&transaction, &draft.project_root, &draft.transition_id)?
        {
            let state = get_state_on(&transaction, &draft.project_root, &draft.plugin_id)?
                .ok_or_else(|| StoreError::Validation("transition state is missing".to_string()))?;
            if transition_matches_draft(&existing, &draft) {
                transaction.commit()?;
                return Ok(WorkspacePluginTransitionRequestResult {
                    outcome: PluginLifecycleMutationOutcome::Unchanged,
                    state,
                    transition: existing,
                });
            }
            return Err(StoreError::Validation(
                "transition ID already belongs to different lifecycle intent".to_string(),
            ));
        }
        let state = get_state_on(&transaction, &draft.project_root, &draft.plugin_id)?.ok_or_else(
            || {
                StoreError::Validation(
                    "workspace plugin must be discovered before a transition is requested"
                        .to_string(),
                )
            },
        )?;
        if transition_requires_expected_digest(&draft.kind)
            && state.accepted_digest != draft.expected_old_digest
        {
            transaction.commit()?;
            return Ok(WorkspacePluginTransitionRequestResult {
                outcome: PluginLifecycleMutationOutcome::Stale,
                state,
                transition: synthetic_transition(&draft),
            });
        }
        let active: Option<String> = transaction
            .query_row(
                "SELECT transition_id FROM workspace_plugin_transitions
                 WHERE project_root = ?1 AND plugin_id = ?2
                   AND status IN ('pending', 'running', 'completion_uncertain')
                 LIMIT 1",
                params![draft.project_root, draft.plugin_id],
                |row| row.get(0),
            )
            .optional()?;
        if active.is_some() {
            transaction.commit()?;
            return Ok(WorkspacePluginTransitionRequestResult {
                outcome: PluginLifecycleMutationOutcome::Conflict,
                state,
                transition: synthetic_transition(&draft),
            });
        }

        let now = Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO workspace_plugin_transitions(
                transition_id, project_root, plugin_id, kind,
                expected_old_digest, candidate_digest, rollback_digest,
                phase, status, requested_at, updated_at, completed_at,
                reason_code, backup_path_key
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7,
                      'requested', 'pending', ?8, ?8, NULL, NULL, ?9)",
            params![
                draft.transition_id,
                draft.project_root,
                draft.plugin_id,
                draft.kind,
                draft.expected_old_digest,
                draft.candidate_digest,
                draft.rollback_digest,
                now,
                draft.backup_path_key,
            ],
        )?;
        transaction.execute(
            "UPDATE workspace_plugin_states
             SET desired_state = ?3, transition_id = ?4,
                 pending_digest = COALESCE(?5, pending_digest),
                 rollback_digest = COALESCE(?6, rollback_digest),
                 last_error_code = NULL, updated_at = ?7
             WHERE project_root = ?1 AND plugin_id = ?2",
            params![
                draft.project_root,
                draft.plugin_id,
                draft.desired_state,
                draft.transition_id,
                draft.candidate_digest,
                draft.rollback_digest,
                now,
            ],
        )?;
        insert_lifecycle_event(
            &transaction,
            LifecycleEventInsert {
                project_root: &draft.project_root,
                plugin_id: &draft.plugin_id,
                transition_id: Some(&draft.transition_id),
                package_digest: draft.candidate_digest.as_deref(),
                event_type: &draft.request_event_type,
                status: "pending",
                phase: "requested",
                reason_code: None,
                details_json: "{}",
                created_at: &now,
            },
        )?;
        let state = get_state_on(&transaction, &draft.project_root, &draft.plugin_id)?
            .ok_or_else(|| StoreError::Validation("transition state disappeared".to_string()))?;
        let transition =
            get_transition_on(&transaction, &draft.project_root, &draft.transition_id)?
                .ok_or_else(|| StoreError::Validation("transition disappeared".to_string()))?;
        transaction.commit()?;
        Ok(WorkspacePluginTransitionRequestResult {
            outcome: PluginLifecycleMutationOutcome::Applied,
            state,
            transition,
        })
    }

    pub fn advance_workspace_plugin_transition(
        &mut self,
        draft: &WorkspacePluginTransitionAdvance,
    ) -> Result<PluginLifecycleMutationOutcome, StoreError> {
        let draft = validate_transition_advance(draft)?;
        let Some(current) =
            self.get_workspace_plugin_transition(&draft.project_root, &draft.transition_id)?
        else {
            return Ok(PluginLifecycleMutationOutcome::NotFound);
        };
        if current.phase == draft.next_phase && current.status == draft.status {
            return Ok(PluginLifecycleMutationOutcome::Unchanged);
        }
        if current.phase != draft.expected_phase
            || phase_rank(&draft.next_phase)? <= phase_rank(&current.phase)?
            || is_terminal_transition_status(&current.status)
        {
            return Ok(PluginLifecycleMutationOutcome::Stale);
        }
        let now = Utc::now().to_rfc3339();
        let completed_at = is_terminal_transition_status(&draft.status).then_some(now.clone());
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE workspace_plugin_transitions
             SET phase = ?4, status = ?5, updated_at = ?6, completed_at = ?7,
                 reason_code = ?8
             WHERE project_root = ?1 AND transition_id = ?2 AND phase = ?3",
            params![
                draft.project_root,
                draft.transition_id,
                draft.expected_phase,
                draft.next_phase,
                draft.status,
                now,
                completed_at,
                draft.reason_code,
            ],
        )?;
        if changed != 1 {
            return Ok(PluginLifecycleMutationOutcome::Stale);
        }
        let plugin_id: String = transaction.query_row(
            "SELECT plugin_id FROM workspace_plugin_transitions
             WHERE project_root = ?1 AND transition_id = ?2",
            params![draft.project_root, draft.transition_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE workspace_plugin_states
             SET observed_state = ?3,
                 accepted_digest = COALESCE(?4, accepted_digest),
                 pending_digest = CASE WHEN ?5 THEN NULL ELSE COALESCE(?6, pending_digest) END,
                 rollback_digest = COALESCE(?7, rollback_digest),
                 last_host_session_id = COALESCE(?8, last_host_session_id),
                 last_error_code = ?9,
                 enabled_at = CASE WHEN ?3 = 'active' THEN ?10 ELSE enabled_at END,
                 disabled_at = CASE WHEN ?3 IN ('disabled', 'stopped', 'uninstalled') THEN ?10 ELSE disabled_at END,
                 updated_at = ?10
             WHERE project_root = ?1 AND plugin_id = ?2",
            params![
                draft.project_root,
                plugin_id,
                draft.observed_state,
                draft.accepted_digest,
                draft.clear_pending_digest,
                draft.pending_digest,
                draft.rollback_digest,
                draft.last_host_session_id,
                draft.last_error_code,
                now,
            ],
        )?;
        insert_lifecycle_event(
            &transaction,
            LifecycleEventInsert {
                project_root: &draft.project_root,
                plugin_id: &plugin_id,
                transition_id: Some(&draft.transition_id),
                package_digest: draft
                    .accepted_digest
                    .as_deref()
                    .or(draft.pending_digest.as_deref()),
                event_type: &draft.event_type,
                status: &draft.event_status,
                phase: &draft.next_phase,
                reason_code: draft.reason_code.as_deref(),
                details_json: &draft.details_json,
                created_at: &now,
            },
        )?;
        transaction.commit()?;
        Ok(PluginLifecycleMutationOutcome::Applied)
    }

    pub fn allocate_workspace_plugin_generation(
        &mut self,
        project_root: &str,
        plugin_id: &str,
        transition_id: &str,
        expected_last_generation: i64,
    ) -> Result<WorkspacePluginGenerationAllocation, StoreError> {
        let project_root = required_project_root(project_root)?;
        let plugin_id = validate_identifier(plugin_id, "plugin id")?;
        let transition_id = validate_identifier(transition_id, "transition id")?;
        if expected_last_generation < 0 || expected_last_generation == i64::MAX {
            return Err(StoreError::Validation(
                "activation generation expectation is invalid".to_string(),
            ));
        }
        let next = expected_last_generation + 1;
        let changed = self.connection.execute(
            "UPDATE workspace_plugin_states
             SET last_activation_generation = ?4, updated_at = ?5
             WHERE project_root = ?1 AND plugin_id = ?2 AND transition_id = ?3
               AND last_activation_generation = ?6
               AND EXISTS (
                    SELECT 1 FROM workspace_plugin_transitions
                    WHERE transition_id = ?3 AND project_root = ?1 AND plugin_id = ?2
                      AND status IN ('pending', 'running', 'completion_uncertain')
               )",
            params![
                project_root,
                plugin_id,
                transition_id,
                next,
                Utc::now().to_rfc3339(),
                expected_last_generation,
            ],
        )?;
        let generation = self
            .get_workspace_plugin_state(&project_root, &plugin_id)?
            .map(|state| state.last_activation_generation)
            .unwrap_or(expected_last_generation);
        Ok(WorkspacePluginGenerationAllocation {
            outcome: if changed == 1 {
                PluginLifecycleMutationOutcome::Applied
            } else if self
                .get_workspace_plugin_state(&project_root, &plugin_id)?
                .is_some()
            {
                PluginLifecycleMutationOutcome::Stale
            } else {
                PluginLifecycleMutationOutcome::NotFound
            },
            generation,
        })
    }

    /// Atomically records exact trash ownership and the durable uninstall
    /// terminal state. The caller must already have moved the package and
    /// advanced the exact uninstall transition to `package_moved`.
    pub fn complete_workspace_plugin_uninstall(
        &mut self,
        transition_id: &str,
        draft: &WorkspacePluginTombstoneDraft,
    ) -> Result<WorkspacePluginUninstallCompletion, StoreError> {
        let transition_id = validate_identifier(transition_id, "transition id")?;
        let draft = validate_tombstone(draft)?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let transition = get_transition_on(&transaction, &draft.project_root, &transition_id)?
            .ok_or_else(|| StoreError::Validation("uninstall transition is missing".to_string()))?;
        let state = get_state_on(&transaction, &draft.project_root, &draft.plugin_id)?.ok_or_else(
            || StoreError::Validation("uninstall plugin state is missing".to_string()),
        )?;
        let existing = get_tombstone_on(&transaction, &draft.project_root, &draft.tombstone_id)?;

        let exact_transition = transition.plugin_id == draft.plugin_id
            && transition.kind == "uninstall"
            && transition.expected_old_digest.as_deref() == Some(draft.package_digest.as_str())
            && transition.backup_path_key.as_deref() == Some(draft.backup_path_key.as_str());
        let exact_state = state.directory_name == draft.original_directory_name
            && state.accepted_digest.as_deref() == Some(draft.package_digest.as_str())
            && state.desired_state == "uninstalled"
            && state.transition_id.as_deref() == Some(transition_id.as_str());
        let recoverable_user_uninstall =
            draft.retention_class == "recoverable" && draft.reason_code == "user_uninstall";
        if !exact_transition || !exact_state || !recoverable_user_uninstall {
            return Err(StoreError::Validation(
                "uninstall completion does not match durable lifecycle identity".to_string(),
            ));
        }

        if transition.phase == "completed"
            && transition.status == "completed"
            && state.observed_state == "uninstalled"
        {
            let tombstone = existing.ok_or_else(|| {
                StoreError::Validation("completed uninstall is missing tombstone truth".to_string())
            })?;
            ensure_tombstone_matches(&tombstone, &draft)?;
            transaction.commit()?;
            return Ok(WorkspacePluginUninstallCompletion {
                outcome: PluginLifecycleMutationOutcome::Unchanged,
                state,
                transition,
                tombstone,
            });
        }

        if transition.phase != "package_moved"
            || !matches!(
                transition.status.as_str(),
                "pending" | "running" | "completion_uncertain"
            )
        {
            transaction.commit()?;
            return Ok(WorkspacePluginUninstallCompletion {
                outcome: PluginLifecycleMutationOutcome::Stale,
                state,
                transition,
                tombstone: existing.unwrap_or_else(|| synthetic_tombstone(&draft)),
            });
        }

        let tombstone = if let Some(existing) = existing {
            ensure_tombstone_matches(&existing, &draft)?;
            existing
        } else {
            transaction.execute(
                "INSERT INTO workspace_plugin_package_tombstones(
                    tombstone_id, project_root, plugin_id, package_digest,
                    backup_path_key, original_directory_name, moved_at,
                    deleted_at, restored_at, retention_class, reason_code
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9)",
                params![
                    draft.tombstone_id,
                    draft.project_root,
                    draft.plugin_id,
                    draft.package_digest,
                    draft.backup_path_key,
                    draft.original_directory_name,
                    now,
                    draft.retention_class,
                    draft.reason_code,
                ],
            )?;
            get_tombstone_on(&transaction, &draft.project_root, &draft.tombstone_id)?.ok_or_else(
                || StoreError::Validation("uninstall tombstone disappeared".to_string()),
            )?
        };

        let changed = transaction.execute(
            "UPDATE workspace_plugin_transitions
             SET phase = 'completed', status = 'completed', updated_at = ?3,
                 completed_at = ?3, reason_code = 'user_uninstall'
             WHERE project_root = ?1 AND transition_id = ?2
               AND phase = 'package_moved'
               AND status IN ('pending', 'running', 'completion_uncertain')",
            params![draft.project_root, transition_id, now],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return Ok(WorkspacePluginUninstallCompletion {
                outcome: PluginLifecycleMutationOutcome::Stale,
                state,
                transition,
                tombstone,
            });
        }
        let state_changed = transaction.execute(
            "UPDATE workspace_plugin_states
             SET desired_state = 'uninstalled', observed_state = 'uninstalled',
                 pending_digest = NULL, last_host_session_id = NULL,
                 last_error_code = NULL, disabled_at = ?3, updated_at = ?3
             WHERE project_root = ?1 AND plugin_id = ?2 AND transition_id = ?4",
            params![draft.project_root, draft.plugin_id, now, transition_id],
        )?;
        if state_changed != 1 {
            return Err(StoreError::Validation(
                "uninstall terminal state update was stale".to_string(),
            ));
        }
        insert_lifecycle_event(
            &transaction,
            LifecycleEventInsert {
                project_root: &draft.project_root,
                plugin_id: &draft.plugin_id,
                transition_id: Some(&transition_id),
                package_digest: Some(&draft.package_digest),
                event_type: "transition_completed",
                status: "completed",
                phase: "completed",
                reason_code: Some("user_uninstall"),
                details_json: r#"{"package_ownership":"trash","recoverable":true}"#,
                created_at: &now,
            },
        )?;
        let state = get_state_on(&transaction, &draft.project_root, &draft.plugin_id)?.ok_or_else(
            || StoreError::Validation("uninstalled plugin state disappeared".to_string()),
        )?;
        let transition = get_transition_on(&transaction, &draft.project_root, &transition_id)?
            .ok_or_else(|| {
                StoreError::Validation("uninstall transition disappeared".to_string())
            })?;
        transaction.commit()?;
        Ok(WorkspacePluginUninstallCompletion {
            outcome: PluginLifecycleMutationOutcome::Applied,
            state,
            transition,
            tombstone,
        })
    }

    /// Atomically marks an exact tombstone restored and leaves the package
    /// disabled. The caller must already have restored the physical package.
    pub fn complete_workspace_plugin_restore(
        &mut self,
        project_root: &str,
        tombstone_id: &str,
    ) -> Result<WorkspacePluginRestoreCompletion, StoreError> {
        let project_root = required_project_root(project_root)?;
        let tombstone_id = validate_identifier(tombstone_id, "tombstone id")?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let tombstone = get_tombstone_on(&transaction, &project_root, &tombstone_id)?
            .ok_or_else(|| StoreError::Validation("plugin tombstone is missing".to_string()))?;
        if tombstone.deleted_at.is_some() {
            return Err(StoreError::Validation(
                "deleted plugin tombstone cannot be restored".to_string(),
            ));
        }
        if tombstone.retention_class != "recoverable" {
            return Err(StoreError::Validation(
                "plugin tombstone is not recoverable".to_string(),
            ));
        }
        let state =
            get_state_on(&transaction, &project_root, &tombstone.plugin_id)?.ok_or_else(|| {
                StoreError::Validation("restored plugin state is missing".to_string())
            })?;
        let exact = state.directory_name == tombstone.original_directory_name
            && state.accepted_digest.as_deref() == Some(tombstone.package_digest.as_str());
        if !exact {
            return Err(StoreError::Validation(
                "restore tombstone does not match durable lifecycle identity".to_string(),
            ));
        }
        if tombstone.restored_at.is_some()
            && state.desired_state == "disabled"
            && state.observed_state == "disabled"
        {
            transaction.commit()?;
            return Ok(WorkspacePluginRestoreCompletion {
                outcome: PluginLifecycleMutationOutcome::Unchanged,
                state,
                tombstone,
            });
        }
        if tombstone.restored_at.is_some()
            || state.desired_state != "uninstalled"
            || state.observed_state != "uninstalled"
        {
            transaction.commit()?;
            return Ok(WorkspacePluginRestoreCompletion {
                outcome: PluginLifecycleMutationOutcome::Stale,
                state,
                tombstone,
            });
        }
        let tombstone_changed = transaction.execute(
            "UPDATE workspace_plugin_package_tombstones
             SET restored_at = ?3
             WHERE project_root = ?1 AND tombstone_id = ?2 AND restored_at IS NULL",
            params![project_root, tombstone_id, now],
        )?;
        let state_changed = transaction.execute(
            "UPDATE workspace_plugin_states
             SET desired_state = 'disabled', observed_state = 'disabled',
                 transition_id = NULL, pending_digest = NULL,
                 last_host_session_id = NULL, last_error_code = NULL,
                 disabled_at = ?3, updated_at = ?3
             WHERE project_root = ?1 AND plugin_id = ?2",
            params![project_root, tombstone.plugin_id, now],
        )?;
        if tombstone_changed != 1 || state_changed != 1 {
            return Err(StoreError::Validation(
                "plugin Restore terminal update was stale".to_string(),
            ));
        }
        insert_lifecycle_event(
            &transaction,
            LifecycleEventInsert {
                project_root: &project_root,
                plugin_id: &tombstone.plugin_id,
                transition_id: None,
                package_digest: Some(&tombstone.package_digest),
                event_type: "recovery",
                status: "completed",
                phase: "completed",
                reason_code: Some("user_restore"),
                details_json: r#"{"package_ownership":"discovery","enabled":false}"#,
                created_at: &now,
            },
        )?;
        let state =
            get_state_on(&transaction, &project_root, &tombstone.plugin_id)?.ok_or_else(|| {
                StoreError::Validation("restored plugin state disappeared".to_string())
            })?;
        let tombstone = get_tombstone_on(&transaction, &project_root, &tombstone_id)?
            .ok_or_else(|| StoreError::Validation("restored tombstone disappeared".to_string()))?;
        transaction.commit()?;
        Ok(WorkspacePluginRestoreCompletion {
            outcome: PluginLifecycleMutationOutcome::Applied,
            state,
            tombstone,
        })
    }

    pub fn expire_workspace_plugin_tombstones(
        &mut self,
        project_root: &str,
        cutoff: &str,
        limit: usize,
    ) -> Result<WorkspacePluginRetentionSweep, StoreError> {
        let project_root = required_project_root(project_root)?;
        let cutoff = DateTime::parse_from_rfc3339(cutoff)
            .map_err(|_| StoreError::Validation("plugin retention cutoff is invalid".to_string()))?
            .with_timezone(&Utc)
            .to_rfc3339();
        if limit == 0 || limit > MAX_RETENTION_BATCH {
            return Err(StoreError::Validation(
                "plugin retention batch limit is invalid".to_string(),
            ));
        }
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidates = {
            let mut statement = transaction.prepare(
                "SELECT tombstone_id, project_root, plugin_id, package_digest,
                        backup_path_key, original_directory_name, moved_at,
                        deleted_at, restored_at, retention_class, reason_code
                 FROM workspace_plugin_package_tombstones
                 WHERE project_root = ?1 AND retention_class = 'recoverable'
                   AND moved_at <= ?2 AND deleted_at IS NULL AND restored_at IS NULL
                 ORDER BY moved_at, tombstone_id LIMIT ?3",
            )?;
            statement
                .query_map(
                    params![project_root, cutoff, limit as i64],
                    decode_tombstone,
                )?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut expired = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let changed = transaction.execute(
                "UPDATE workspace_plugin_package_tombstones
                 SET retention_class = 'expired'
                 WHERE project_root = ?1 AND tombstone_id = ?2
                   AND retention_class = 'recoverable'
                   AND deleted_at IS NULL AND restored_at IS NULL",
                params![project_root, candidate.tombstone_id],
            )?;
            if changed != 1 {
                return Err(StoreError::Validation(
                    "plugin retention expiry update was stale".to_string(),
                ));
            }
            insert_lifecycle_event(
                &transaction,
                LifecycleEventInsert {
                    project_root: &project_root,
                    plugin_id: &candidate.plugin_id,
                    transition_id: None,
                    package_digest: Some(&candidate.package_digest),
                    event_type: "recovery",
                    status: "completed",
                    phase: "completed",
                    reason_code: Some("retention_expired"),
                    details_json: r#"{"retention_class":"expired"}"#,
                    created_at: &now,
                },
            )?;
            expired.push(
                get_tombstone_on(&transaction, &project_root, &candidate.tombstone_id)?
                    .ok_or_else(|| {
                        StoreError::Validation("expired plugin tombstone disappeared".to_string())
                    })?,
            );
        }
        transaction.commit()?;
        Ok(WorkspacePluginRetentionSweep {
            outcome: if expired.is_empty() {
                PluginLifecycleMutationOutcome::Unchanged
            } else {
                PluginLifecycleMutationOutcome::Applied
            },
            expired,
        })
    }

    pub fn request_workspace_plugin_purge(
        &mut self,
        draft: &WorkspacePluginPurgeDraft,
    ) -> Result<WorkspacePluginPurgeResult, StoreError> {
        let draft = validate_purge_draft(draft)?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let tombstone = get_tombstone_on(&transaction, &draft.project_root, &draft.tombstone_id)?
            .ok_or_else(|| {
            StoreError::Validation("plugin purge tombstone is missing".to_string())
        })?;
        ensure_purge_identity(&tombstone, &draft)?;
        if tombstone.deleted_at.is_some() && tombstone.retention_class == "expired" {
            transaction.commit()?;
            return Ok(WorkspacePluginPurgeResult {
                outcome: PluginLifecycleMutationOutcome::Unchanged,
                tombstone,
            });
        }
        if tombstone.deleted_at.is_some() || tombstone.restored_at.is_some() {
            transaction.commit()?;
            return Ok(WorkspacePluginPurgeResult {
                outcome: PluginLifecycleMutationOutcome::Stale,
                tombstone,
            });
        }
        if tombstone.retention_class == "purge_pending" {
            transaction.commit()?;
            return Ok(WorkspacePluginPurgeResult {
                outcome: PluginLifecycleMutationOutcome::Unchanged,
                tombstone,
            });
        }
        if tombstone.retention_class != "expired" {
            transaction.commit()?;
            return Ok(WorkspacePluginPurgeResult {
                outcome: PluginLifecycleMutationOutcome::Stale,
                tombstone,
            });
        }
        let changed = transaction.execute(
            "UPDATE workspace_plugin_package_tombstones
             SET retention_class = 'purge_pending'
             WHERE project_root = ?1 AND tombstone_id = ?2
               AND retention_class = 'expired'
               AND deleted_at IS NULL AND restored_at IS NULL",
            params![draft.project_root, draft.tombstone_id],
        )?;
        if changed != 1 {
            return Err(StoreError::Validation(
                "plugin purge request update was stale".to_string(),
            ));
        }
        insert_lifecycle_event(
            &transaction,
            LifecycleEventInsert {
                project_root: &draft.project_root,
                plugin_id: &draft.plugin_id,
                transition_id: None,
                package_digest: Some(&draft.package_digest),
                event_type: "recovery",
                status: "pending",
                phase: "completed",
                reason_code: Some("purge_requested"),
                details_json: r#"{"retention_class":"purge_pending"}"#,
                created_at: &now,
            },
        )?;
        let tombstone = get_tombstone_on(&transaction, &draft.project_root, &draft.tombstone_id)?
            .ok_or_else(|| {
            StoreError::Validation("pending purge tombstone disappeared".to_string())
        })?;
        transaction.commit()?;
        Ok(WorkspacePluginPurgeResult {
            outcome: PluginLifecycleMutationOutcome::Applied,
            tombstone,
        })
    }

    pub fn complete_workspace_plugin_purge(
        &mut self,
        draft: &WorkspacePluginPurgeDraft,
    ) -> Result<WorkspacePluginPurgeResult, StoreError> {
        let draft = validate_purge_draft(draft)?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let tombstone = get_tombstone_on(&transaction, &draft.project_root, &draft.tombstone_id)?
            .ok_or_else(|| {
            StoreError::Validation("plugin purge tombstone is missing".to_string())
        })?;
        ensure_purge_identity(&tombstone, &draft)?;
        if tombstone.deleted_at.is_some() && tombstone.retention_class == "expired" {
            transaction.commit()?;
            return Ok(WorkspacePluginPurgeResult {
                outcome: PluginLifecycleMutationOutcome::Unchanged,
                tombstone,
            });
        }
        if tombstone.retention_class != "purge_pending"
            || tombstone.deleted_at.is_some()
            || tombstone.restored_at.is_some()
        {
            transaction.commit()?;
            return Ok(WorkspacePluginPurgeResult {
                outcome: PluginLifecycleMutationOutcome::Stale,
                tombstone,
            });
        }
        let changed = transaction.execute(
            "UPDATE workspace_plugin_package_tombstones
             SET retention_class = 'expired', deleted_at = ?3
             WHERE project_root = ?1 AND tombstone_id = ?2
               AND retention_class = 'purge_pending'
               AND deleted_at IS NULL AND restored_at IS NULL",
            params![draft.project_root, draft.tombstone_id, now],
        )?;
        if changed != 1 {
            return Err(StoreError::Validation(
                "plugin purge completion update was stale".to_string(),
            ));
        }
        insert_lifecycle_event(
            &transaction,
            LifecycleEventInsert {
                project_root: &draft.project_root,
                plugin_id: &draft.plugin_id,
                transition_id: None,
                package_digest: Some(&draft.package_digest),
                event_type: "recovery",
                status: "completed",
                phase: "completed",
                reason_code: Some("purge_completed"),
                details_json: r#"{"package_ownership":"deleted","retention_class":"expired"}"#,
                created_at: &now,
            },
        )?;
        let tombstone = get_tombstone_on(&transaction, &draft.project_root, &draft.tombstone_id)?
            .ok_or_else(|| {
            StoreError::Validation("completed purge tombstone disappeared".to_string())
        })?;
        transaction.commit()?;
        Ok(WorkspacePluginPurgeResult {
            outcome: PluginLifecycleMutationOutcome::Applied,
            tombstone,
        })
    }

    pub fn record_workspace_plugin_crash(
        &mut self,
        project_root: &str,
        plugin_id: &str,
        package_digest: &str,
        host_session_id: &str,
        reason_code: &str,
    ) -> Result<WorkspacePluginCrashOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        let plugin_id = validate_identifier(plugin_id, "plugin id")?;
        let package_digest = validate_digest(package_digest, "package digest")?;
        let host_session_id = validate_identifier(host_session_id, "host session id")?;
        let reason_code = validate_identifier(reason_code, "crash reason code")?;
        let now = Utc::now();
        let now_text = now.to_rfc3339();
        let cutoff = (now - Duration::minutes(10)).to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = get_state_on(&transaction, &project_root, &plugin_id)?.ok_or_else(|| {
            StoreError::Validation("crashed plugin lifecycle state is missing".to_string())
        })?;
        let exact = state.desired_state == "enabled"
            && state.accepted_digest.as_deref() == Some(package_digest.as_str())
            && state.last_host_session_id.as_deref() == Some(host_session_id.as_str());
        if !exact {
            transaction.commit()?;
            return Ok(WorkspacePluginCrashOutcome {
                outcome: PluginLifecycleMutationOutcome::Stale,
                crash_count: 0,
                blocked: false,
                state,
            });
        }
        let prior_crashes: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM workspace_plugin_lifecycle_events
             WHERE project_root = ?1 AND plugin_id = ?2
               AND event_type = 'host_quarantined' AND created_at >= ?3",
            params![project_root, plugin_id, cutoff],
            |row| row.get(0),
        )?;
        let crash_count = usize::try_from(prior_crashes)
            .unwrap_or(usize::MAX)
            .saturating_add(1);
        let blocked = crash_count >= 3;
        transaction.execute(
            "UPDATE workspace_plugin_states
             SET observed_state = ?3, last_error_code = ?4, updated_at = ?5
             WHERE project_root = ?1 AND plugin_id = ?2",
            params![
                project_root,
                plugin_id,
                if blocked { "blocked" } else { "crashed" },
                if blocked {
                    "crash_loop_blocked"
                } else {
                    reason_code.as_str()
                },
                now_text,
            ],
        )?;
        insert_lifecycle_event(
            &transaction,
            LifecycleEventInsert {
                project_root: &project_root,
                plugin_id: &plugin_id,
                transition_id: state.transition_id.as_deref(),
                package_digest: Some(&package_digest),
                event_type: "host_quarantined",
                status: "failed",
                phase: "completed",
                reason_code: Some(if blocked {
                    "crash_loop_blocked"
                } else {
                    reason_code.as_str()
                }),
                details_json: &serde_json::json!({"crash_count": crash_count}).to_string(),
                created_at: &now_text,
            },
        )?;
        let updated = get_state_on(&transaction, &project_root, &plugin_id)?.ok_or_else(|| {
            StoreError::Validation("crashed plugin state disappeared".to_string())
        })?;
        transaction.commit()?;
        Ok(WorkspacePluginCrashOutcome {
            outcome: PluginLifecycleMutationOutcome::Applied,
            crash_count,
            blocked,
            state: updated,
        })
    }

    pub fn get_workspace_plugin_state(
        &self,
        project_root: &str,
        plugin_id: &str,
    ) -> Result<Option<WorkspacePluginState>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let plugin_id = validate_identifier(plugin_id, "plugin id")?;
        get_state_on(&self.connection, &project_root, &plugin_id)
    }

    pub fn list_workspace_plugin_states(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<WorkspacePluginState>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let mut statement = self.connection.prepare(
            "SELECT project_root, plugin_id, directory_name, plugin_version,
                    accepted_digest, pending_digest, rollback_digest, runtime_kind,
                    desired_state, observed_state, last_activation_generation,
                    last_host_session_id, transition_id, last_error_code,
                    enabled_at, disabled_at, updated_at
             FROM workspace_plugin_states WHERE project_root = ?1
             ORDER BY plugin_id LIMIT ?2",
        )?;
        statement
            .query_map(
                params![
                    project_root,
                    limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as i64
                ],
                decode_state,
            )?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_workspace_plugin_transition(
        &self,
        project_root: &str,
        transition_id: &str,
    ) -> Result<Option<WorkspacePluginTransition>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let transition_id = validate_identifier(transition_id, "transition id")?;
        get_transition_on(&self.connection, &project_root, &transition_id)
    }

    pub fn list_nonterminal_workspace_plugin_transitions(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<WorkspacePluginTransition>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let mut statement = self.connection.prepare(
            "SELECT transition_id, project_root, plugin_id, kind,
                    expected_old_digest, candidate_digest, rollback_digest,
                    phase, status, requested_at, updated_at, completed_at,
                    reason_code, backup_path_key
             FROM workspace_plugin_transitions
             WHERE project_root = ?1
               AND status IN ('pending', 'running', 'completion_uncertain')
             ORDER BY requested_at, transition_id LIMIT ?2",
        )?;
        statement
            .query_map(
                params![
                    project_root,
                    limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as i64
                ],
                decode_transition,
            )?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_workspace_plugin_lifecycle_events(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<WorkspacePluginLifecycleEvent>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let mut statement = self.connection.prepare(
            "SELECT event_id, project_root, plugin_id, transition_id,
                    package_digest, event_type, status, phase, reason_code,
                    details_json, created_at
             FROM workspace_plugin_lifecycle_events
             WHERE project_root = ?1 ORDER BY created_at DESC, event_id LIMIT ?2",
        )?;
        statement
            .query_map(
                params![
                    project_root,
                    limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as i64
                ],
                decode_event,
            )?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_workspace_plugin_tombstone(
        &self,
        project_root: &str,
        tombstone_id: &str,
    ) -> Result<Option<WorkspacePluginPackageTombstone>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let tombstone_id = validate_identifier(tombstone_id, "tombstone id")?;
        get_tombstone_on(&self.connection, &project_root, &tombstone_id)
    }

    pub fn list_workspace_plugin_tombstones(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<WorkspacePluginPackageTombstone>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let mut statement = self.connection.prepare(
            "SELECT tombstone_id, project_root, plugin_id, package_digest,
                    backup_path_key, original_directory_name, moved_at,
                    deleted_at, restored_at, retention_class, reason_code
             FROM workspace_plugin_package_tombstones
             WHERE project_root = ?1
             ORDER BY moved_at DESC, tombstone_id LIMIT ?2",
        )?;
        statement
            .query_map(
                params![
                    project_root,
                    limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as i64
                ],
                decode_tombstone,
            )?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}

fn get_state_on(
    connection: &rusqlite::Connection,
    project_root: &str,
    plugin_id: &str,
) -> Result<Option<WorkspacePluginState>, StoreError> {
    connection
        .query_row(
            "SELECT project_root, plugin_id, directory_name, plugin_version,
                    accepted_digest, pending_digest, rollback_digest, runtime_kind,
                    desired_state, observed_state, last_activation_generation,
                    last_host_session_id, transition_id, last_error_code,
                    enabled_at, disabled_at, updated_at
             FROM workspace_plugin_states
             WHERE project_root = ?1 AND plugin_id = ?2",
            params![project_root, plugin_id],
            decode_state,
        )
        .optional()
        .map_err(StoreError::from)
}

fn get_transition_on(
    connection: &rusqlite::Connection,
    project_root: &str,
    transition_id: &str,
) -> Result<Option<WorkspacePluginTransition>, StoreError> {
    connection
        .query_row(
            "SELECT transition_id, project_root, plugin_id, kind,
                    expected_old_digest, candidate_digest, rollback_digest,
                    phase, status, requested_at, updated_at, completed_at,
                    reason_code, backup_path_key
             FROM workspace_plugin_transitions
             WHERE project_root = ?1 AND transition_id = ?2",
            params![project_root, transition_id],
            decode_transition,
        )
        .optional()
        .map_err(StoreError::from)
}

fn get_tombstone_on(
    connection: &rusqlite::Connection,
    project_root: &str,
    tombstone_id: &str,
) -> Result<Option<WorkspacePluginPackageTombstone>, StoreError> {
    connection
        .query_row(
            "SELECT tombstone_id, project_root, plugin_id, package_digest,
                    backup_path_key, original_directory_name, moved_at,
                    deleted_at, restored_at, retention_class, reason_code
             FROM workspace_plugin_package_tombstones
             WHERE project_root = ?1 AND tombstone_id = ?2",
            params![project_root, tombstone_id],
            decode_tombstone,
        )
        .optional()
        .map_err(StoreError::from)
}

fn decode_state(row: &Row<'_>) -> rusqlite::Result<WorkspacePluginState> {
    Ok(WorkspacePluginState {
        project_root: row.get(0)?,
        plugin_id: row.get(1)?,
        directory_name: row.get(2)?,
        plugin_version: row.get(3)?,
        accepted_digest: row.get(4)?,
        pending_digest: row.get(5)?,
        rollback_digest: row.get(6)?,
        runtime_kind: row.get(7)?,
        desired_state: row.get(8)?,
        observed_state: row.get(9)?,
        last_activation_generation: row.get(10)?,
        last_host_session_id: row.get(11)?,
        transition_id: row.get(12)?,
        last_error_code: row.get(13)?,
        enabled_at: row.get(14)?,
        disabled_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn decode_transition(row: &Row<'_>) -> rusqlite::Result<WorkspacePluginTransition> {
    Ok(WorkspacePluginTransition {
        transition_id: row.get(0)?,
        project_root: row.get(1)?,
        plugin_id: row.get(2)?,
        kind: row.get(3)?,
        expected_old_digest: row.get(4)?,
        candidate_digest: row.get(5)?,
        rollback_digest: row.get(6)?,
        phase: row.get(7)?,
        status: row.get(8)?,
        requested_at: row.get(9)?,
        updated_at: row.get(10)?,
        completed_at: row.get(11)?,
        reason_code: row.get(12)?,
        backup_path_key: row.get(13)?,
    })
}

fn decode_event(row: &Row<'_>) -> rusqlite::Result<WorkspacePluginLifecycleEvent> {
    Ok(WorkspacePluginLifecycleEvent {
        event_id: row.get(0)?,
        project_root: row.get(1)?,
        plugin_id: row.get(2)?,
        transition_id: row.get(3)?,
        package_digest: row.get(4)?,
        event_type: row.get(5)?,
        status: row.get(6)?,
        phase: row.get(7)?,
        reason_code: row.get(8)?,
        details_json: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn decode_tombstone(row: &Row<'_>) -> rusqlite::Result<WorkspacePluginPackageTombstone> {
    Ok(WorkspacePluginPackageTombstone {
        tombstone_id: row.get(0)?,
        project_root: row.get(1)?,
        plugin_id: row.get(2)?,
        package_digest: row.get(3)?,
        backup_path_key: row.get(4)?,
        original_directory_name: row.get(5)?,
        moved_at: row.get(6)?,
        deleted_at: row.get(7)?,
        restored_at: row.get(8)?,
        retention_class: row.get(9)?,
        reason_code: row.get(10)?,
    })
}

struct LifecycleEventInsert<'a> {
    project_root: &'a str,
    plugin_id: &'a str,
    transition_id: Option<&'a str>,
    package_digest: Option<&'a str>,
    event_type: &'a str,
    status: &'a str,
    phase: &'a str,
    reason_code: Option<&'a str>,
    details_json: &'a str,
    created_at: &'a str,
}

fn insert_lifecycle_event(
    connection: &rusqlite::Connection,
    event: LifecycleEventInsert<'_>,
) -> Result<String, StoreError> {
    validate_event_type(event.event_type)?;
    validate_event_status(event.status)?;
    phase_rank(event.phase)?;
    let details_json = validate_details_json(event.details_json)?;
    let event_id = format!("event.{}", uuid::Uuid::new_v4().simple());
    connection.execute(
        "INSERT INTO workspace_plugin_lifecycle_events(
            event_id, project_root, plugin_id, transition_id, package_digest,
            event_type, status, phase, reason_code, details_json, created_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            event_id,
            event.project_root,
            event.plugin_id,
            event.transition_id,
            event.package_digest,
            event.event_type,
            event.status,
            event.phase,
            event.reason_code,
            details_json,
            event.created_at,
        ],
    )?;
    Ok(event_id)
}

fn validate_discovered(
    draft: &WorkspacePluginDiscoveredDraft,
) -> Result<WorkspacePluginDiscoveredDraft, StoreError> {
    Ok(WorkspacePluginDiscoveredDraft {
        project_root: required_project_root(&draft.project_root)?,
        plugin_id: validate_identifier(&draft.plugin_id, "plugin id")?,
        directory_name: validate_directory_name(&draft.directory_name)?,
        plugin_version: validate_version(&draft.plugin_version)?,
        runtime_kind: validate_runtime_kind(&draft.runtime_kind)?,
        discovered_digest: validate_digest(&draft.discovered_digest, "discovered digest")?,
    })
}

fn validate_transition_draft(
    draft: &WorkspacePluginTransitionDraft,
) -> Result<WorkspacePluginTransitionDraft, StoreError> {
    let kind = validate_transition_kind(&draft.kind)?;
    let request_event_type = draft.request_event_type.trim().to_string();
    if !matches!(request_event_type.as_str(), "user_requested" | "recovery") {
        return Err(StoreError::Validation(
            "plugin transition request event must be user_requested or recovery".to_string(),
        ));
    }
    let desired_state = validate_desired_state(&draft.desired_state)?;
    let expected_desired = desired_state_for_kind(&kind);
    let desired_matches = if matches!(kind.as_str(), "project_teardown" | "shutdown") {
        matches!(desired_state.as_str(), "enabled" | "disabled")
    } else {
        desired_state == expected_desired
    };
    if !desired_matches {
        return Err(StoreError::Validation(format!(
            "transition kind {kind} requires desired state {expected_desired}"
        )));
    }
    let expected_old_digest = draft
        .expected_old_digest
        .as_deref()
        .map(|value| validate_digest(value, "expected old digest"))
        .transpose()?;
    let candidate_digest = draft
        .candidate_digest
        .as_deref()
        .map(|value| validate_digest(value, "candidate digest"))
        .transpose()?;
    let rollback_digest = draft
        .rollback_digest
        .as_deref()
        .map(|value| validate_digest(value, "rollback digest"))
        .transpose()?;
    if matches!(kind.as_str(), "enable" | "retry") && candidate_digest.is_none() {
        return Err(StoreError::Validation(
            "enable/retry transition requires a candidate digest".to_string(),
        ));
    }
    if matches!(kind.as_str(), "upgrade" | "rollback")
        && (expected_old_digest.is_none() || candidate_digest.is_none())
    {
        return Err(StoreError::Validation(
            "upgrade/rollback transition requires expected and candidate digests".to_string(),
        ));
    }
    if expected_old_digest.is_some() && expected_old_digest == candidate_digest {
        return Err(StoreError::Validation(
            "transition candidate digest must differ from expected old digest".to_string(),
        ));
    }
    Ok(WorkspacePluginTransitionDraft {
        transition_id: validate_identifier(&draft.transition_id, "transition id")?,
        project_root: required_project_root(&draft.project_root)?,
        plugin_id: validate_identifier(&draft.plugin_id, "plugin id")?,
        kind,
        request_event_type,
        desired_state,
        expected_old_digest,
        candidate_digest,
        rollback_digest,
        backup_path_key: draft
            .backup_path_key
            .as_deref()
            .map(validate_opaque_key)
            .transpose()?,
    })
}

fn validate_transition_advance(
    draft: &WorkspacePluginTransitionAdvance,
) -> Result<WorkspacePluginTransitionAdvance, StoreError> {
    let project_root = required_project_root(&draft.project_root)?;
    let transition_id = validate_identifier(&draft.transition_id, "transition id")?;
    phase_rank(&draft.expected_phase)?;
    phase_rank(&draft.next_phase)?;
    validate_transition_status(&draft.status)?;
    if is_terminal_transition_status(&draft.status) != (draft.next_phase == "completed") {
        return Err(StoreError::Validation(
            "terminal plugin transition status requires completed phase".to_string(),
        ));
    }
    validate_observed_state(&draft.observed_state)?;
    validate_event_type(&draft.event_type)?;
    validate_event_status(&draft.event_status)?;
    let reason_code = draft
        .reason_code
        .as_deref()
        .map(|value| validate_identifier(value, "reason code"))
        .transpose()?;
    let last_error_code = draft
        .last_error_code
        .as_deref()
        .map(|value| validate_identifier(value, "error code"))
        .transpose()?;
    let last_host_session_id = draft
        .last_host_session_id
        .as_deref()
        .map(|value| validate_identifier(value, "host session id"))
        .transpose()?;
    Ok(WorkspacePluginTransitionAdvance {
        project_root,
        transition_id,
        expected_phase: draft.expected_phase.clone(),
        next_phase: draft.next_phase.clone(),
        status: draft.status.clone(),
        observed_state: draft.observed_state.clone(),
        accepted_digest: validate_optional_digest(
            draft.accepted_digest.as_deref(),
            "accepted digest",
        )?,
        pending_digest: validate_optional_digest(
            draft.pending_digest.as_deref(),
            "pending digest",
        )?,
        rollback_digest: validate_optional_digest(
            draft.rollback_digest.as_deref(),
            "rollback digest",
        )?,
        clear_pending_digest: draft.clear_pending_digest,
        last_host_session_id,
        last_error_code,
        reason_code,
        event_type: draft.event_type.clone(),
        event_status: draft.event_status.clone(),
        details_json: validate_details_json(&draft.details_json)?,
    })
}

fn validate_tombstone(
    draft: &WorkspacePluginTombstoneDraft,
) -> Result<WorkspacePluginTombstoneDraft, StoreError> {
    if !matches!(
        draft.retention_class.as_str(),
        "recoverable" | "expired" | "purge_pending"
    ) {
        return Err(StoreError::Validation(
            "unsupported plugin tombstone retention class".to_string(),
        ));
    }
    Ok(WorkspacePluginTombstoneDraft {
        tombstone_id: validate_identifier(&draft.tombstone_id, "tombstone id")?,
        project_root: required_project_root(&draft.project_root)?,
        plugin_id: validate_identifier(&draft.plugin_id, "plugin id")?,
        package_digest: validate_digest(&draft.package_digest, "package digest")?,
        backup_path_key: validate_opaque_key(&draft.backup_path_key)?,
        original_directory_name: validate_directory_name(&draft.original_directory_name)?,
        retention_class: draft.retention_class.clone(),
        reason_code: validate_identifier(&draft.reason_code, "reason code")?,
    })
}

fn validate_purge_draft(
    draft: &WorkspacePluginPurgeDraft,
) -> Result<WorkspacePluginPurgeDraft, StoreError> {
    Ok(WorkspacePluginPurgeDraft {
        project_root: required_project_root(&draft.project_root)?,
        tombstone_id: validate_identifier(&draft.tombstone_id, "tombstone id")?,
        plugin_id: validate_identifier(&draft.plugin_id, "plugin id")?,
        package_digest: validate_digest(&draft.package_digest, "package digest")?,
        backup_path_key: validate_opaque_key(&draft.backup_path_key)?,
        original_directory_name: validate_directory_name(&draft.original_directory_name)?,
    })
}

fn ensure_purge_identity(
    tombstone: &WorkspacePluginPackageTombstone,
    draft: &WorkspacePluginPurgeDraft,
) -> Result<(), StoreError> {
    if tombstone.plugin_id == draft.plugin_id
        && tombstone.package_digest == draft.package_digest
        && tombstone.backup_path_key == draft.backup_path_key
        && tombstone.original_directory_name == draft.original_directory_name
    {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "plugin purge identity does not match tombstone truth".to_string(),
        ))
    }
}

fn ensure_tombstone_matches(
    tombstone: &WorkspacePluginPackageTombstone,
    draft: &WorkspacePluginTombstoneDraft,
) -> Result<(), StoreError> {
    let exact = tombstone.plugin_id == draft.plugin_id
        && tombstone.package_digest == draft.package_digest
        && tombstone.backup_path_key == draft.backup_path_key
        && tombstone.original_directory_name == draft.original_directory_name
        && tombstone.retention_class == draft.retention_class
        && tombstone.reason_code == draft.reason_code
        && tombstone.deleted_at.is_none()
        && tombstone.restored_at.is_none();
    if exact {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "tombstone ID already belongs to different package evidence".to_string(),
        ))
    }
}

fn synthetic_tombstone(draft: &WorkspacePluginTombstoneDraft) -> WorkspacePluginPackageTombstone {
    WorkspacePluginPackageTombstone {
        tombstone_id: draft.tombstone_id.clone(),
        project_root: draft.project_root.clone(),
        plugin_id: draft.plugin_id.clone(),
        package_digest: draft.package_digest.clone(),
        backup_path_key: draft.backup_path_key.clone(),
        original_directory_name: draft.original_directory_name.clone(),
        moved_at: String::new(),
        deleted_at: None,
        restored_at: None,
        retention_class: draft.retention_class.clone(),
        reason_code: draft.reason_code.clone(),
    }
}

fn transition_matches_draft(
    transition: &WorkspacePluginTransition,
    draft: &WorkspacePluginTransitionDraft,
) -> bool {
    transition.plugin_id == draft.plugin_id
        && transition.kind == draft.kind
        && transition.expected_old_digest == draft.expected_old_digest
        && transition.candidate_digest == draft.candidate_digest
        && transition.rollback_digest == draft.rollback_digest
        && transition.backup_path_key == draft.backup_path_key
}

fn synthetic_transition(draft: &WorkspacePluginTransitionDraft) -> WorkspacePluginTransition {
    WorkspacePluginTransition {
        transition_id: draft.transition_id.clone(),
        project_root: draft.project_root.clone(),
        plugin_id: draft.plugin_id.clone(),
        kind: draft.kind.clone(),
        expected_old_digest: draft.expected_old_digest.clone(),
        candidate_digest: draft.candidate_digest.clone(),
        rollback_digest: draft.rollback_digest.clone(),
        phase: "requested".to_string(),
        status: "pending".to_string(),
        requested_at: String::new(),
        updated_at: String::new(),
        completed_at: None,
        reason_code: None,
        backup_path_key: draft.backup_path_key.clone(),
    }
}

fn phase_rank(value: &str) -> Result<usize, StoreError> {
    TRANSITION_PHASES
        .iter()
        .position(|phase| phase == &value)
        .ok_or_else(|| {
            StoreError::Validation(format!("unsupported plugin transition phase: {value}"))
        })
}

fn validate_transition_kind(value: &str) -> Result<String, StoreError> {
    if matches!(
        value,
        "enable"
            | "disable"
            | "uninstall"
            | "retry"
            | "upgrade"
            | "rollback"
            | "project_teardown"
            | "shutdown"
    ) {
        Ok(value.to_string())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin transition kind".to_string(),
        ))
    }
}

fn desired_state_for_kind(kind: &str) -> &'static str {
    match kind {
        "enable" | "retry" | "upgrade" | "rollback" => "enabled",
        "uninstall" => "uninstalled",
        "disable" => "disabled",
        "project_teardown" | "shutdown" => "enabled_or_disabled",
        _ => unreachable!(),
    }
}

fn transition_requires_expected_digest(kind: &str) -> bool {
    matches!(
        kind,
        "disable" | "uninstall" | "upgrade" | "rollback" | "project_teardown" | "shutdown"
    )
}

fn validate_desired_state(value: &str) -> Result<String, StoreError> {
    if matches!(value, "disabled" | "enabled" | "uninstalled") {
        Ok(value.to_string())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin desired state".to_string(),
        ))
    }
}

fn validate_observed_state(value: &str) -> Result<(), StoreError> {
    if matches!(
        value,
        "discovered"
            | "disabled"
            | "resolving"
            | "activating"
            | "active"
            | "quiescing"
            | "disposing"
            | "stopped"
            | "crashed"
            | "update_pending"
            | "rollback_pending"
            | "uninstalled"
            | "blocked"
    ) {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin observed state".to_string(),
        ))
    }
}

fn validate_transition_status(value: &str) -> Result<(), StoreError> {
    if matches!(
        value,
        "pending" | "running" | "completed" | "failed" | "cancelled" | "completion_uncertain"
    ) {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin transition status".to_string(),
        ))
    }
}

fn is_terminal_transition_status(value: &str) -> bool {
    matches!(value, "completed" | "failed" | "cancelled")
}

fn validate_event_type(value: &str) -> Result<(), StoreError> {
    if matches!(
        value,
        "discovery"
            | "user_requested"
            | "preflight"
            | "grant_state"
            | "activation"
            | "routing_published"
            | "call_drain"
            | "call_cancelled"
            | "handles_revoked"
            | "contributions_disposed"
            | "host_disposed"
            | "host_quarantined"
            | "package_backed_up"
            | "pointer_cas"
            | "rollback"
            | "recovery"
            | "transition_completed"
            | "transition_failed"
    ) {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin lifecycle event type".to_string(),
        ))
    }
}

fn validate_event_status(value: &str) -> Result<(), StoreError> {
    if matches!(
        value,
        "pending" | "completed" | "failed" | "cancelled" | "stale" | "uncertain"
    ) {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin lifecycle event status".to_string(),
        ))
    }
}

fn validate_details_json(value: &str) -> Result<String, StoreError> {
    if value.len() > MAX_DETAILS_BYTES {
        return Err(StoreError::Validation(
            "plugin lifecycle details exceed their byte budget".to_string(),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_str(value)?;
    let object = parsed.as_object().ok_or_else(|| {
        StoreError::Validation("plugin lifecycle details must be an object".to_string())
    })?;
    if object.len() > 24 {
        return Err(StoreError::Validation(
            "plugin lifecycle details contain too many fields".to_string(),
        ));
    }
    for (key, value) in object {
        let lower = key.to_ascii_lowercase();
        if key.is_empty()
            || key.len() > 64
            || key.chars().any(char::is_control)
            || [
                "handle",
                "credential",
                "token",
                "secret",
                "content",
                "payload",
                "url",
                "header",
                "wasm",
                "memory",
                "workspace_id",
                "full_path",
            ]
            .iter()
            .any(|forbidden| lower.contains(forbidden))
        {
            return Err(StoreError::Validation(
                "plugin lifecycle details contain a forbidden field".to_string(),
            ));
        }
        let valid = value.is_null()
            || value.is_boolean()
            || value.is_number()
            || value.as_str().is_some_and(|value| {
                value.len() <= 128
                    && !value.chars().any(char::is_control)
                    && !value.contains("handle.")
                    && !value.contains("://")
                    && !value.contains('/')
                    && !value.contains('\\')
            });
        if !valid {
            return Err(StoreError::Validation(
                "plugin lifecycle details contain an unsafe value".to_string(),
            ));
        }
    }
    serde_json::to_string(&parsed).map_err(StoreError::from)
}

fn validate_identifier(value: &str, label: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(StoreError::Validation(format!("invalid {label}")));
    }
    Ok(value.to_string())
}

fn validate_directory_name(value: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || matches!(value, "." | "..")
        || value.contains(['/', '\\', ':'])
        || value.chars().any(char::is_control)
    {
        return Err(StoreError::Validation(
            "invalid workspace plugin directory component".to_string(),
        ));
    }
    Ok(value.to_string())
}

fn validate_opaque_key(value: &str) -> Result<String, StoreError> {
    let value = validate_identifier(value, "opaque backup key")?;
    if value.contains(':') {
        return Err(StoreError::Validation(
            "opaque backup key must not be a path".to_string(),
        ));
    }
    Ok(value)
}

fn validate_version(value: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.len() > MAX_IDENTIFIER_BYTES || semver::Version::parse(value).is_err() {
        return Err(StoreError::Validation(
            "plugin lifecycle version must be semantic".to_string(),
        ));
    }
    Ok(value.to_string())
}

fn validate_runtime_kind(value: &str) -> Result<String, StoreError> {
    if value == "wasm" {
        Ok(value.to_string())
    } else {
        Err(StoreError::Validation(
            "plugin lifecycle runtime kind must be wasm".to_string(),
        ))
    }
}

fn validate_digest(value: &str, label: &str) -> Result<String, StoreError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(StoreError::Validation(format!("invalid {label}")));
    }
    Ok(value.to_string())
}

fn validate_optional_digest(
    value: Option<&str>,
    label: &str,
) -> Result<Option<String>, StoreError> {
    value.map(|value| validate_digest(value, label)).transpose()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use tempfile::tempdir;

    use super::*;

    fn digest(value: char) -> String {
        value.to_string().repeat(64)
    }

    fn discovered(project_root: &str) -> WorkspacePluginDiscoveredDraft {
        WorkspacePluginDiscoveredDraft {
            project_root: project_root.to_string(),
            plugin_id: "org.example.plugin".to_string(),
            directory_name: "example-plugin".to_string(),
            plugin_version: "1.0.0".to_string(),
            runtime_kind: "wasm".to_string(),
            discovered_digest: digest('a'),
        }
    }

    fn transition(
        project_root: &str,
        transition_id: &str,
        kind: &str,
        desired_state: &str,
        expected_old_digest: Option<String>,
        candidate_digest: Option<String>,
    ) -> WorkspacePluginTransitionDraft {
        WorkspacePluginTransitionDraft {
            transition_id: transition_id.to_string(),
            project_root: project_root.to_string(),
            plugin_id: "org.example.plugin".to_string(),
            kind: kind.to_string(),
            request_event_type: "user_requested".to_string(),
            desired_state: desired_state.to_string(),
            expected_old_digest,
            candidate_digest,
            rollback_digest: None,
            backup_path_key: None,
        }
    }

    fn advance(
        project_root: &str,
        transition_id: &str,
        expected_phase: &str,
        next_phase: &str,
        status: &str,
        observed_state: &str,
    ) -> WorkspacePluginTransitionAdvance {
        WorkspacePluginTransitionAdvance {
            project_root: project_root.to_string(),
            transition_id: transition_id.to_string(),
            expected_phase: expected_phase.to_string(),
            next_phase: next_phase.to_string(),
            status: status.to_string(),
            observed_state: observed_state.to_string(),
            accepted_digest: None,
            pending_digest: None,
            rollback_digest: None,
            clear_pending_digest: false,
            last_host_session_id: None,
            last_error_code: None,
            reason_code: None,
            event_type: "preflight".to_string(),
            event_status: "completed".to_string(),
            details_json: "{}".to_string(),
        }
    }

    fn prepare_package_moved_uninstall(
        store: &mut Store,
        project_root: &str,
        transition_id: &str,
    ) -> WorkspacePluginTombstoneDraft {
        store
            .upsert_discovered_workspace_plugin(&discovered(project_root))
            .unwrap();
        let enable_id = format!("{transition_id}.enable");
        let enable = transition(
            project_root,
            &enable_id,
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        store.request_workspace_plugin_transition(&enable).unwrap();
        let mut enabled = advance(
            project_root,
            &enable_id,
            "requested",
            "completed",
            "completed",
            "active",
        );
        enabled.accepted_digest = Some(digest('a'));
        enabled.clear_pending_digest = true;
        enabled.event_type = "transition_completed".to_string();
        store.advance_workspace_plugin_transition(&enabled).unwrap();

        let trash_key = format!("trash.{transition_id}");
        let mut uninstall = transition(
            project_root,
            transition_id,
            "uninstall",
            "uninstalled",
            Some(digest('a')),
            None,
        );
        uninstall.backup_path_key = Some(trash_key.clone());
        assert_eq!(
            store
                .request_workspace_plugin_transition(&uninstall)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
        let mut moved = advance(
            project_root,
            transition_id,
            "requested",
            "package_moved",
            "running",
            "disposing",
        );
        moved.event_type = "recovery".to_string();
        moved.details_json = r#"{"package_ownership":"trash"}"#.to_string();
        assert_eq!(
            store.advance_workspace_plugin_transition(&moved).unwrap(),
            PluginLifecycleMutationOutcome::Applied
        );
        WorkspacePluginTombstoneDraft {
            tombstone_id: format!("tombstone.{transition_id}"),
            project_root: project_root.to_string(),
            plugin_id: "org.example.plugin".to_string(),
            package_digest: digest('a'),
            backup_path_key: trash_key,
            original_directory_name: "example-plugin".to_string(),
            retention_class: "recoverable".to_string(),
            reason_code: "user_uninstall".to_string(),
        }
    }

    fn purge_draft(tombstone: &WorkspacePluginTombstoneDraft) -> WorkspacePluginPurgeDraft {
        WorkspacePluginPurgeDraft {
            project_root: tombstone.project_root.clone(),
            tombstone_id: tombstone.tombstone_id.clone(),
            plugin_id: tombstone.plugin_id.clone(),
            package_digest: tombstone.package_digest.clone(),
            backup_path_key: tombstone.backup_path_key.clone(),
            original_directory_name: tombstone.original_directory_name.clone(),
        }
    }

    #[test]
    fn discovery_transition_generation_and_reopen_are_monotonic_and_project_scoped() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let project_a = "/project/a";
        let project_b = "/project/b";
        let mut store = Store::open(&database).unwrap();
        let (outcome, state) = store
            .upsert_discovered_workspace_plugin(&discovered(project_a))
            .unwrap();
        assert_eq!(outcome, PluginLifecycleMutationOutcome::Applied);
        assert_eq!(state.desired_state, "disabled");
        assert_eq!(state.observed_state, "discovered");
        assert!(state.accepted_digest.is_none());
        assert_eq!(state.pending_digest, Some(digest('a')));
        assert_eq!(
            store
                .upsert_discovered_workspace_plugin(&discovered(project_a))
                .unwrap()
                .0,
            PluginLifecycleMutationOutcome::Unchanged
        );

        let enable = transition(
            project_a,
            "transition.enable.a",
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        let requested = store.request_workspace_plugin_transition(&enable).unwrap();
        assert_eq!(requested.outcome, PluginLifecycleMutationOutcome::Applied);
        assert_eq!(requested.state.desired_state, "enabled");
        assert_eq!(requested.state.observed_state, "discovered");
        assert_eq!(
            store
                .request_workspace_plugin_transition(&enable)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        let conflict = transition(
            project_a,
            "transition.enable.other",
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        assert_eq!(
            store
                .request_workspace_plugin_transition(&conflict)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Conflict
        );

        let generation = store
            .allocate_workspace_plugin_generation(
                project_a,
                "org.example.plugin",
                "transition.enable.a",
                0,
            )
            .unwrap();
        assert_eq!(generation.outcome, PluginLifecycleMutationOutcome::Applied);
        assert_eq!(generation.generation, 1);
        assert_eq!(
            store
                .allocate_workspace_plugin_generation(
                    project_a,
                    "org.example.plugin",
                    "transition.enable.a",
                    0,
                )
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Stale
        );

        let preflight = advance(
            project_a,
            "transition.enable.a",
            "requested",
            "preflight",
            "running",
            "resolving",
        );
        assert_eq!(
            store
                .advance_workspace_plugin_transition(&preflight)
                .unwrap(),
            PluginLifecycleMutationOutcome::Applied
        );
        let backwards = advance(
            project_a,
            "transition.enable.a",
            "preflight",
            "requested",
            "running",
            "resolving",
        );
        assert_eq!(
            store
                .advance_workspace_plugin_transition(&backwards)
                .unwrap(),
            PluginLifecycleMutationOutcome::Stale
        );
        let mut unsafe_failure = advance(
            project_a,
            "transition.enable.a",
            "preflight",
            "completed",
            "failed",
            "disabled",
        );
        unsafe_failure.event_type = "transition_failed".to_string();
        unsafe_failure.event_status = "failed".to_string();
        unsafe_failure.reason_code = Some("host_trap".to_string());
        unsafe_failure.details_json = r#"{"raw_handle":"handle.secret"}"#.to_string();
        assert!(
            store
                .advance_workspace_plugin_transition(&unsafe_failure)
                .is_err()
        );
        unsafe_failure.details_json = r#"{"attempt":1}"#.to_string();
        unsafe_failure.last_error_code = Some("host_trap".to_string());
        assert_eq!(
            store
                .advance_workspace_plugin_transition(&unsafe_failure)
                .unwrap(),
            PluginLifecycleMutationOutcome::Applied
        );
        assert!(
            store
                .list_nonterminal_workspace_plugin_transitions(project_a, None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .allocate_workspace_plugin_generation(
                    project_a,
                    "org.example.plugin",
                    "transition.enable.a",
                    1,
                )
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Stale
        );

        let retry = transition(
            project_a,
            "transition.retry.a",
            "retry",
            "enabled",
            None,
            Some(digest('a')),
        );
        store.request_workspace_plugin_transition(&retry).unwrap();
        assert_eq!(
            store
                .allocate_workspace_plugin_generation(
                    project_a,
                    "org.example.plugin",
                    "transition.retry.a",
                    1,
                )
                .unwrap()
                .generation,
            2
        );
        store
            .upsert_discovered_workspace_plugin(&discovered(project_b))
            .unwrap();
        assert_eq!(
            store
                .list_workspace_plugin_states(project_a, None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_workspace_plugin_states(project_b, None)
                .unwrap()
                .len(),
            1
        );
        drop(store);

        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened
                .get_workspace_plugin_state(project_a, "org.example.plugin")
                .unwrap()
                .unwrap()
                .last_activation_generation,
            2
        );
        assert!(
            reopened
                .list_workspace_plugin_lifecycle_events(project_a, None)
                .unwrap()
                .iter()
                .all(|event| !event.details_json.contains("handle."))
        );
    }

    #[test]
    fn accepted_pointer_uninstall_tombstone_and_stale_digest_are_fail_closed() {
        let directory = tempdir().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project = "/project/a";
        store
            .upsert_discovered_workspace_plugin(&discovered(project))
            .unwrap();
        let enable = transition(
            project,
            "transition.enable",
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        store.request_workspace_plugin_transition(&enable).unwrap();
        let mut completed = advance(
            project,
            "transition.enable",
            "requested",
            "completed",
            "completed",
            "active",
        );
        completed.accepted_digest = Some(digest('a'));
        completed.clear_pending_digest = true;
        completed.event_type = "transition_completed".to_string();
        store
            .advance_workspace_plugin_transition(&completed)
            .unwrap();
        let (rediscovery_outcome, rediscovered_state) = store
            .upsert_discovered_workspace_plugin(&discovered(project))
            .unwrap();
        assert_eq!(
            rediscovery_outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        assert_eq!(rediscovered_state.observed_state, "active");
        assert_eq!(rediscovered_state.accepted_digest, Some(digest('a')));
        assert!(rediscovered_state.pending_digest.is_none());

        let teardown = transition(
            project,
            "transition.project-teardown",
            "project_teardown",
            "enabled",
            Some(digest('a')),
            None,
        );
        assert_eq!(
            store
                .request_workspace_plugin_transition(&teardown)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
        let mut teardown_completed = advance(
            project,
            "transition.project-teardown",
            "requested",
            "completed",
            "completed",
            "stopped",
        );
        teardown_completed.event_type = "transition_completed".to_string();
        store
            .advance_workspace_plugin_transition(&teardown_completed)
            .unwrap();
        let stopped = store
            .get_workspace_plugin_state(project, "org.example.plugin")
            .unwrap()
            .unwrap();
        assert_eq!(stopped.desired_state, "enabled");
        assert_eq!(stopped.observed_state, "stopped");
        assert_eq!(stopped.accepted_digest, Some(digest('a')));

        let stale = transition(
            project,
            "transition.uninstall.stale",
            "uninstall",
            "uninstalled",
            Some(digest('b')),
            None,
        );
        assert_eq!(
            store
                .request_workspace_plugin_transition(&stale)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Stale
        );
        let mut uninstall = transition(
            project,
            "transition.uninstall",
            "uninstall",
            "uninstalled",
            Some(digest('a')),
            None,
        );
        uninstall.backup_path_key = Some("trash.transition_uninstall".to_string());
        assert_eq!(
            store
                .request_workspace_plugin_transition(&uninstall)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
        let tombstone = WorkspacePluginTombstoneDraft {
            tombstone_id: "tombstone.a".to_string(),
            project_root: project.to_string(),
            plugin_id: "org.example.plugin".to_string(),
            package_digest: digest('a'),
            backup_path_key: "trash.transition_uninstall".to_string(),
            original_directory_name: "example-plugin".to_string(),
            retention_class: "recoverable".to_string(),
            reason_code: "user_uninstall".to_string(),
        };
        let mut moved = advance(
            project,
            "transition.uninstall",
            "requested",
            "package_moved",
            "running",
            "disposing",
        );
        moved.event_type = "recovery".to_string();
        store.advance_workspace_plugin_transition(&moved).unwrap();
        assert_eq!(
            store
                .complete_workspace_plugin_uninstall("transition.uninstall", &tombstone)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
        assert_eq!(
            store
                .complete_workspace_plugin_uninstall("transition.uninstall", &tombstone)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        let mut unsafe_tombstone = tombstone.clone();
        unsafe_tombstone.tombstone_id = "tombstone.unsafe".to_string();
        unsafe_tombstone.backup_path_key = "../escape".to_string();
        assert!(
            store
                .complete_workspace_plugin_uninstall("transition.uninstall", &unsafe_tombstone)
                .is_err()
        );
        assert!(
            store
                .get_workspace_plugin_tombstone("/project/b", "tombstone.a")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn uninstall_completion_and_restore_are_atomic_idempotent_and_reopen_safe() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let project = "/project/a";
        let transition_id = "transition.uninstall.atomic";
        let mut store = Store::open(&database).unwrap();
        let tombstone = prepare_package_moved_uninstall(&mut store, project, transition_id);

        let completed = store
            .complete_workspace_plugin_uninstall(transition_id, &tombstone)
            .unwrap();
        assert_eq!(completed.outcome, PluginLifecycleMutationOutcome::Applied);
        assert_eq!(completed.state.desired_state, "uninstalled");
        assert_eq!(completed.state.observed_state, "uninstalled");
        assert_eq!(completed.transition.phase, "completed");
        assert_eq!(completed.transition.status, "completed");
        assert_eq!(
            completed.tombstone.backup_path_key,
            tombstone.backup_path_key
        );
        assert_eq!(
            store
                .complete_workspace_plugin_uninstall(transition_id, &tombstone)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        assert_eq!(
            store
                .list_workspace_plugin_tombstones(project, None)
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .get_workspace_plugin_tombstone("/project/b", &tombstone.tombstone_id)
                .unwrap()
                .is_none()
        );
        drop(store);

        let mut reopened = Store::open(&database).unwrap();
        let restored = reopened
            .complete_workspace_plugin_restore(project, &tombstone.tombstone_id)
            .unwrap();
        assert_eq!(restored.outcome, PluginLifecycleMutationOutcome::Applied);
        assert_eq!(restored.state.desired_state, "disabled");
        assert_eq!(restored.state.observed_state, "disabled");
        assert!(restored.state.transition_id.is_none());
        assert!(restored.tombstone.restored_at.is_some());
        assert_eq!(
            reopened
                .complete_workspace_plugin_restore(project, &tombstone.tombstone_id)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        assert!(
            reopened
                .complete_workspace_plugin_restore("/project/b", &tombstone.tombstone_id)
                .is_err()
        );
    }

    #[test]
    fn uninstall_completion_failure_rolls_back_tombstone_and_terminal_state() {
        let directory = tempdir().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project = "/project/a";
        let transition_id = "transition.uninstall.injected";
        let tombstone = prepare_package_moved_uninstall(&mut store, project, transition_id);
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_plugin_uninstall_terminal
                 BEFORE UPDATE OF phase ON workspace_plugin_transitions
                 WHEN NEW.phase = 'completed' AND OLD.kind = 'uninstall'
                 BEGIN SELECT RAISE(ABORT, 'injected uninstall terminal failure'); END;",
            )
            .unwrap();
        assert!(
            store
                .complete_workspace_plugin_uninstall(transition_id, &tombstone)
                .is_err()
        );
        assert!(
            store
                .get_workspace_plugin_tombstone(project, &tombstone.tombstone_id)
                .unwrap()
                .is_none()
        );
        let state = store
            .get_workspace_plugin_state(project, "org.example.plugin")
            .unwrap()
            .unwrap();
        assert_eq!(state.desired_state, "uninstalled");
        assert_ne!(state.observed_state, "uninstalled");
        let transition = store
            .get_workspace_plugin_transition(project, transition_id)
            .unwrap()
            .unwrap();
        assert_eq!(transition.phase, "package_moved");
        assert_eq!(transition.status, "running");

        store
            .connection
            .execute_batch("DROP TRIGGER fail_plugin_uninstall_terminal;")
            .unwrap();
        assert_eq!(
            store
                .complete_workspace_plugin_uninstall(transition_id, &tombstone)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
    }

    #[test]
    fn restore_completion_failure_rolls_back_tombstone_and_state_then_retries() {
        let directory = tempdir().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project = "/project/a";
        let transition_id = "transition.uninstall.restore-injected";
        let tombstone = prepare_package_moved_uninstall(&mut store, project, transition_id);
        store
            .complete_workspace_plugin_uninstall(transition_id, &tombstone)
            .unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_plugin_restore_state
                 BEFORE UPDATE OF desired_state ON workspace_plugin_states
                 WHEN NEW.desired_state = 'disabled' AND OLD.desired_state = 'uninstalled'
                 BEGIN SELECT RAISE(ABORT, 'injected restore state failure'); END;",
            )
            .unwrap();
        assert!(
            store
                .complete_workspace_plugin_restore(project, &tombstone.tombstone_id)
                .is_err()
        );
        let unchanged_tombstone = store
            .get_workspace_plugin_tombstone(project, &tombstone.tombstone_id)
            .unwrap()
            .unwrap();
        assert!(unchanged_tombstone.restored_at.is_none());
        let unchanged_state = store
            .get_workspace_plugin_state(project, "org.example.plugin")
            .unwrap()
            .unwrap();
        assert_eq!(unchanged_state.desired_state, "uninstalled");
        assert_eq!(unchanged_state.observed_state, "uninstalled");

        store
            .connection
            .execute_batch("DROP TRIGGER fail_plugin_restore_state;")
            .unwrap();
        assert_eq!(
            store
                .complete_workspace_plugin_restore(project, &tombstone.tombstone_id)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
    }

    #[test]
    fn retention_expiry_purge_and_terminal_tombstone_are_bounded_and_project_scoped() {
        let directory = tempdir().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project_a = "/project/a";
        let project_b = "/project/b";
        let tombstone_a =
            prepare_package_moved_uninstall(&mut store, project_a, "transition.retention.a");
        store
            .complete_workspace_plugin_uninstall("transition.retention.a", &tombstone_a)
            .unwrap();
        let tombstone_b =
            prepare_package_moved_uninstall(&mut store, project_b, "transition.retention.b");
        store
            .complete_workspace_plugin_uninstall("transition.retention.b", &tombstone_b)
            .unwrap();

        let before_move = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        assert_eq!(
            store
                .expire_workspace_plugin_tombstones(project_a, &before_move, 1)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        let after_move = (Utc::now() + Duration::minutes(1)).to_rfc3339();
        let expired = store
            .expire_workspace_plugin_tombstones(project_a, &after_move, 1)
            .unwrap();
        assert_eq!(expired.outcome, PluginLifecycleMutationOutcome::Applied);
        assert_eq!(expired.expired.len(), 1);
        assert_eq!(expired.expired[0].retention_class, "expired");
        assert_eq!(
            store
                .get_workspace_plugin_tombstone(project_b, &tombstone_b.tombstone_id)
                .unwrap()
                .unwrap()
                .retention_class,
            "recoverable"
        );
        assert!(
            store
                .expire_workspace_plugin_tombstones(project_a, &after_move, 0)
                .is_err()
        );
        assert!(
            store
                .expire_workspace_plugin_tombstones(project_a, &after_move, 101)
                .is_err()
        );
        assert!(
            store
                .expire_workspace_plugin_tombstones(project_a, "not-a-time", 1)
                .is_err()
        );

        let draft = purge_draft(&tombstone_a);
        assert_eq!(
            store
                .request_workspace_plugin_purge(&draft)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
        assert_eq!(
            store
                .request_workspace_plugin_purge(&draft)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        let mut wrong = draft.clone();
        wrong.package_digest = digest('f');
        assert!(store.request_workspace_plugin_purge(&wrong).is_err());
        let completed = store.complete_workspace_plugin_purge(&draft).unwrap();
        assert_eq!(completed.outcome, PluginLifecycleMutationOutcome::Applied);
        assert_eq!(completed.tombstone.retention_class, "expired");
        assert!(completed.tombstone.deleted_at.is_some());
        assert_eq!(
            store
                .complete_workspace_plugin_purge(&draft)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Unchanged
        );
        assert!(
            store
                .get_workspace_plugin_tombstone(project_b, &tombstone_a.tombstone_id)
                .unwrap()
                .is_none()
        );
        let reasons = store
            .list_workspace_plugin_lifecycle_events(project_a, Some(100))
            .unwrap()
            .into_iter()
            .filter_map(|event| event.reason_code)
            .collect::<Vec<_>>();
        for reason in ["retention_expired", "purge_requested", "purge_completed"] {
            assert!(reasons.iter().any(|actual| actual == reason));
        }
    }

    #[test]
    fn retention_and_purge_persistence_failures_roll_back_and_reopen_retry() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let project = "/project/a";
        let transition_id = "transition.retention.failure";
        let mut store = Store::open(&database).unwrap();
        let tombstone = prepare_package_moved_uninstall(&mut store, project, transition_id);
        store
            .complete_workspace_plugin_uninstall(transition_id, &tombstone)
            .unwrap();
        let cutoff = (Utc::now() + Duration::minutes(1)).to_rfc3339();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_retention_event
                 BEFORE INSERT ON workspace_plugin_lifecycle_events
                 WHEN NEW.reason_code = 'retention_expired'
                 BEGIN SELECT RAISE(ABORT, 'injected retention event failure'); END;",
            )
            .unwrap();
        assert!(
            store
                .expire_workspace_plugin_tombstones(project, &cutoff, 1)
                .is_err()
        );
        assert_eq!(
            store
                .get_workspace_plugin_tombstone(project, &tombstone.tombstone_id)
                .unwrap()
                .unwrap()
                .retention_class,
            "recoverable"
        );
        store
            .connection
            .execute_batch("DROP TRIGGER fail_retention_event;")
            .unwrap();
        store
            .expire_workspace_plugin_tombstones(project, &cutoff, 1)
            .unwrap();
        let draft = purge_draft(&tombstone);
        store.request_workspace_plugin_purge(&draft).unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_purge_terminal_event
                 BEFORE INSERT ON workspace_plugin_lifecycle_events
                 WHEN NEW.reason_code = 'purge_completed'
                 BEGIN SELECT RAISE(ABORT, 'injected purge completion failure'); END;",
            )
            .unwrap();
        assert!(store.complete_workspace_plugin_purge(&draft).is_err());
        let pending = store
            .get_workspace_plugin_tombstone(project, &tombstone.tombstone_id)
            .unwrap()
            .unwrap();
        assert_eq!(pending.retention_class, "purge_pending");
        assert!(pending.deleted_at.is_none());
        store
            .connection
            .execute_batch("DROP TRIGGER fail_purge_terminal_event;")
            .unwrap();
        drop(store);

        let mut reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened
                .complete_workspace_plugin_purge(&draft)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Applied
        );
    }

    #[test]
    fn concurrent_exact_purge_requests_converge_without_cross_project_takeover() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let project = "/project/a";
        let transition_id = "transition.retention.concurrent";
        let mut store = Store::open(&database).unwrap();
        let tombstone = prepare_package_moved_uninstall(&mut store, project, transition_id);
        store
            .complete_workspace_plugin_uninstall(transition_id, &tombstone)
            .unwrap();
        store
            .expire_workspace_plugin_tombstones(
                project,
                &(Utc::now() + Duration::minutes(1)).to_rfc3339(),
                1,
            )
            .unwrap();
        drop(store);

        let draft = purge_draft(&tombstone);
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let database = database.clone();
                let draft = draft.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut store = Store::open(database).unwrap();
                    barrier.wait();
                    store
                        .request_workspace_plugin_purge(&draft)
                        .unwrap()
                        .outcome
                })
            })
            .collect::<Vec<_>>();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginLifecycleMutationOutcome::Applied)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginLifecycleMutationOutcome::Unchanged)
                .count(),
            1
        );
    }

    #[test]
    fn uninstall_completion_rejects_wrong_phase_digest_and_project() {
        let directory = tempdir().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project = "/project/a";
        store
            .upsert_discovered_workspace_plugin(&discovered(project))
            .unwrap();
        let enable = transition(
            project,
            "transition.enable.stale-uninstall",
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        store.request_workspace_plugin_transition(&enable).unwrap();
        let mut enabled = advance(
            project,
            "transition.enable.stale-uninstall",
            "requested",
            "completed",
            "completed",
            "active",
        );
        enabled.accepted_digest = Some(digest('a'));
        enabled.event_type = "transition_completed".to_string();
        store.advance_workspace_plugin_transition(&enabled).unwrap();
        let mut uninstall = transition(
            project,
            "transition.uninstall.not-moved",
            "uninstall",
            "uninstalled",
            Some(digest('a')),
            None,
        );
        uninstall.backup_path_key = Some("trash.not-moved".to_string());
        store
            .request_workspace_plugin_transition(&uninstall)
            .unwrap();
        let tombstone = WorkspacePluginTombstoneDraft {
            tombstone_id: "tombstone.not-moved".to_string(),
            project_root: project.to_string(),
            plugin_id: "org.example.plugin".to_string(),
            package_digest: digest('a'),
            backup_path_key: "trash.not-moved".to_string(),
            original_directory_name: "example-plugin".to_string(),
            retention_class: "recoverable".to_string(),
            reason_code: "user_uninstall".to_string(),
        };
        assert_eq!(
            store
                .complete_workspace_plugin_uninstall("transition.uninstall.not-moved", &tombstone,)
                .unwrap()
                .outcome,
            PluginLifecycleMutationOutcome::Stale
        );
        let mut wrong_digest = tombstone.clone();
        wrong_digest.package_digest = digest('b');
        assert!(
            store
                .complete_workspace_plugin_uninstall(
                    "transition.uninstall.not-moved",
                    &wrong_digest,
                )
                .is_err()
        );
        let mut wrong_project = tombstone;
        wrong_project.project_root = "/project/b".to_string();
        assert!(
            store
                .complete_workspace_plugin_uninstall(
                    "transition.uninstall.not-moved",
                    &wrong_project,
                )
                .is_err()
        );
    }

    #[test]
    fn concurrent_transition_requests_are_serialized_and_idempotent() {
        fn run_requests(
            database: &std::path::Path,
            drafts: [WorkspacePluginTransitionDraft; 2],
        ) -> Vec<PluginLifecycleMutationOutcome> {
            let barrier = Arc::new(Barrier::new(2));
            let handles = drafts.map(|draft| {
                let database = database.to_path_buf();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut store = Store::open(database).unwrap();
                    barrier.wait();
                    store
                        .request_workspace_plugin_transition(&draft)
                        .unwrap()
                        .outcome
                })
            });
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect()
        }

        let identical_directory = tempdir().unwrap();
        let identical_database = identical_directory.path().join("rho.sqlite");
        let mut store = Store::open(&identical_database).unwrap();
        store
            .upsert_discovered_workspace_plugin(&discovered("/project/a"))
            .unwrap();
        drop(store);
        let request = transition(
            "/project/a",
            "transition.concurrent.same",
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        let outcomes = run_requests(&identical_database, [request.clone(), request]);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginLifecycleMutationOutcome::Applied)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginLifecycleMutationOutcome::Unchanged)
                .count(),
            1
        );

        let conflict_directory = tempdir().unwrap();
        let conflict_database = conflict_directory.path().join("rho.sqlite");
        let mut store = Store::open(&conflict_database).unwrap();
        store
            .upsert_discovered_workspace_plugin(&discovered("/project/a"))
            .unwrap();
        drop(store);
        let outcomes = run_requests(
            &conflict_database,
            [
                transition(
                    "/project/a",
                    "transition.concurrent.a",
                    "enable",
                    "enabled",
                    None,
                    Some(digest('a')),
                ),
                transition(
                    "/project/a",
                    "transition.concurrent.b",
                    "enable",
                    "enabled",
                    None,
                    Some(digest('a')),
                ),
            ],
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginLifecycleMutationOutcome::Applied)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginLifecycleMutationOutcome::Conflict)
                .count(),
            1
        );
    }

    #[test]
    fn discovery_and_transition_event_failures_roll_back_all_state() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_discovery_event
                 BEFORE INSERT ON workspace_plugin_lifecycle_events
                 WHEN NEW.event_type = 'discovery'
                 BEGIN SELECT RAISE(FAIL, 'injected discovery event failure'); END;",
            )
            .unwrap();
        assert!(
            store
                .upsert_discovered_workspace_plugin(&discovered("/project/a"))
                .is_err()
        );
        assert!(
            store
                .get_workspace_plugin_state("/project/a", "org.example.plugin")
                .unwrap()
                .is_none()
        );
        store
            .connection
            .execute_batch("DROP TRIGGER fail_discovery_event;")
            .unwrap();
        store
            .upsert_discovered_workspace_plugin(&discovered("/project/a"))
            .unwrap();
        let baseline_events = store
            .list_workspace_plugin_lifecycle_events("/project/a", None)
            .unwrap()
            .len();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_transition_event
                 BEFORE INSERT ON workspace_plugin_lifecycle_events
                 WHEN NEW.event_type = 'user_requested'
                 BEGIN SELECT RAISE(FAIL, 'injected transition event failure'); END;",
            )
            .unwrap();
        let request = transition(
            "/project/a",
            "transition.atomic",
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        assert!(store.request_workspace_plugin_transition(&request).is_err());
        let state = store
            .get_workspace_plugin_state("/project/a", "org.example.plugin")
            .unwrap()
            .unwrap();
        assert_eq!(state.desired_state, "disabled");
        assert!(state.transition_id.is_none());
        assert!(
            store
                .get_workspace_plugin_transition("/project/a", "transition.atomic")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .list_workspace_plugin_lifecycle_events("/project/a", None)
                .unwrap()
                .len(),
            baseline_events
        );
    }

    #[test]
    fn crash_events_are_exact_durable_and_block_on_third_event_in_window() {
        let directory = tempdir().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project = "/project/a";
        store
            .upsert_discovered_workspace_plugin(&discovered(project))
            .unwrap();
        let enable = transition(
            project,
            "transition.crash-enable",
            "enable",
            "enabled",
            None,
            Some(digest('a')),
        );
        store.request_workspace_plugin_transition(&enable).unwrap();
        let mut completed = advance(
            project,
            "transition.crash-enable",
            "requested",
            "completed",
            "completed",
            "active",
        );
        completed.accepted_digest = Some(digest('a'));
        completed.clear_pending_digest = true;
        completed.last_host_session_id = Some("instance.crash-a".to_string());
        completed.event_type = "transition_completed".to_string();
        store
            .advance_workspace_plugin_transition(&completed)
            .unwrap();
        let stale = store
            .record_workspace_plugin_crash(
                project,
                "org.example.plugin",
                &digest('a'),
                "instance.foreign",
                "guest_trap",
            )
            .unwrap();
        assert_eq!(stale.outcome, PluginLifecycleMutationOutcome::Stale);
        for expected in 1..=3 {
            let crash = store
                .record_workspace_plugin_crash(
                    project,
                    "org.example.plugin",
                    &digest('a'),
                    "instance.crash-a",
                    "guest_trap",
                )
                .unwrap();
            assert_eq!(crash.crash_count, expected);
            assert_eq!(crash.blocked, expected == 3);
            assert_eq!(
                crash.state.observed_state,
                if expected == 3 { "blocked" } else { "crashed" }
            );
        }
        assert_eq!(
            store
                .list_workspace_plugin_lifecycle_events(project, Some(100))
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "host_quarantined")
                .count(),
            3
        );
    }
}
