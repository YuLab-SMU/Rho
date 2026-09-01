use chrono::Utc;
use rho_protocol::{
    AuthorityDigest, EnvironmentCheckpointV1, EnvironmentDesiredRevisionV1, EnvironmentIdentityV1,
    EnvironmentIncidentV1, EnvironmentOperationOutcomeV1, EnvironmentOperationReceiptV1,
    EnvironmentRealizationRevisionV1, MaterializedPackagePlanV1, WorkspaceEnvironmentBindingV1,
};
use rusqlite::types::Type;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Store, StoreConnection, StoreError, normalize_project_root};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentStateCommit {
    pub project_root: String,
    pub environment: EnvironmentIdentityV1,
    pub desired: EnvironmentDesiredRevisionV1,
    pub realization: EnvironmentRealizationRevisionV1,
    pub receipt: EnvironmentOperationReceiptV1,
    pub binding: WorkspaceEnvironmentBindingV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentStateProjection {
    pub project_root: String,
    pub environment: EnvironmentIdentityV1,
    pub desired: EnvironmentDesiredRevisionV1,
    pub realization: EnvironmentRealizationRevisionV1,
    pub receipt: EnvironmentOperationReceiptV1,
    pub binding: WorkspaceEnvironmentBindingV1,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentIncidentRecord {
    pub project_root: String,
    pub incident: EnvironmentIncidentV1,
    pub status: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentOperationJournalRecord {
    pub operation_id: String,
    pub project_root: String,
    pub environment_id: String,
    pub plan_id: String,
    pub plan: MaterializedPackagePlanV1,
    pub status: String,
    pub checkpoints: Vec<EnvironmentCheckpointV1>,
    pub reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentOperationActivity {
    pub operation_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentPlanReviewRecord {
    pub project_root: String,
    pub plan: MaterializedPackagePlanV1,
    pub status: String,
    pub approval_lease_id: Option<String>,
    pub operation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl<C: StoreConnection> Store<C> {
    pub fn record_environment_plan_for_review(
        &mut self,
        project_root: &str,
        plan: &MaterializedPackagePlanV1,
    ) -> Result<EnvironmentPlanReviewRecord, StoreError> {
        let project_root = required_root(project_root)?;
        plan.validate()
            .map_err(|error| StoreError::Validation(error.to_string()))?;
        let canonical_plan_json = serde_json::to_string(plan)?;
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO environment_plan_reviews(
                project_root, plan_id, environment_id, canonical_plan_json, status,
                approval_lease_id, operation_id, created_at, updated_at
             ) VALUES(?1, ?2, ?3, ?4, 'materialized', NULL, NULL, ?5, ?5)
             ON CONFLICT(project_root, plan_id) DO NOTHING",
            params![
                project_root,
                plan.plan_id.as_str(),
                plan.body.environment.environment_id.as_str(),
                canonical_plan_json,
                now,
            ],
        )?;
        let record = self
            .get_environment_plan_review(&project_root, plan.plan_id.as_str())?
            .ok_or_else(|| {
                StoreError::Validation("Environment plan review insert disappeared".to_string())
            })?;
        if record.plan != *plan {
            return Err(StoreError::Validation(
                "Environment plan identity was reused with different canonical content".to_string(),
            ));
        }
        Ok(record)
    }

    pub fn get_environment_plan_review(
        &self,
        project_root: &str,
        plan_id: &str,
    ) -> Result<Option<EnvironmentPlanReviewRecord>, StoreError> {
        let project_root = required_root(project_root)?;
        self.connection
            .query_row(
                "SELECT project_root, canonical_plan_json, status, approval_lease_id,
                        operation_id, created_at, updated_at
                 FROM environment_plan_reviews
                 WHERE project_root = ?1 AND plan_id = ?2",
                params![project_root, plan_id],
                decode_environment_plan_review,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn latest_reviewable_environment_plan(
        &self,
        project_root: &str,
    ) -> Result<Option<EnvironmentPlanReviewRecord>, StoreError> {
        let project_root = required_root(project_root)?;
        self.connection
            .query_row(
                "SELECT project_root, canonical_plan_json, status, approval_lease_id,
                        operation_id, created_at, updated_at
                 FROM environment_plan_reviews
                 WHERE project_root = ?1 AND status IN ('materialized', 'approved')
                 ORDER BY updated_at DESC, plan_id DESC
                 LIMIT 1",
                [project_root],
                decode_environment_plan_review,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn approve_environment_plan(
        &mut self,
        project_root: &str,
        plan_id: &str,
        approval_lease_id: &str,
        operation_id: &str,
    ) -> Result<EnvironmentPlanReviewRecord, StoreError> {
        let project_root = required_root(project_root)?;
        for (label, value) in [
            ("approval lease", approval_lease_id),
            ("operation", operation_id),
        ] {
            if value.is_empty() || value.trim() != value || value.chars().any(char::is_control) {
                return Err(StoreError::Validation(format!(
                    "Environment plan {label} identity is invalid"
                )));
            }
        }
        let now = Utc::now().to_rfc3339();
        let changed = self.connection.execute(
            "UPDATE environment_plan_reviews
             SET status = 'approved', approval_lease_id = ?3, operation_id = ?4, updated_at = ?5
             WHERE project_root = ?1 AND plan_id = ?2 AND status = 'materialized'",
            params![project_root, plan_id, approval_lease_id, operation_id, now],
        )?;
        let record = self
            .get_environment_plan_review(&project_root, plan_id)?
            .ok_or_else(|| StoreError::Validation("Environment plan is not materialized".into()))?;
        if changed == 0
            && (record.status != "approved"
                || record.approval_lease_id.as_deref() != Some(approval_lease_id)
                || record.operation_id.as_deref() != Some(operation_id))
        {
            return Err(StoreError::Validation(
                "Environment plan cannot be approved from its current state".to_string(),
            ));
        }
        Ok(record)
    }

    pub fn dispatch_approved_environment_plan(
        &mut self,
        project_root: &str,
        plan_id: &str,
        approval_lease_id: &str,
        operation_id: &str,
    ) -> Result<EnvironmentPlanReviewRecord, StoreError> {
        let project_root = required_root(project_root)?;
        let now = Utc::now().to_rfc3339();
        let changed = self.connection.execute(
            "UPDATE environment_plan_reviews
             SET status = 'dispatched', updated_at = ?5
             WHERE project_root = ?1 AND plan_id = ?2 AND status = 'approved'
               AND approval_lease_id = ?3 AND operation_id = ?4",
            params![project_root, plan_id, approval_lease_id, operation_id, now],
        )?;
        let record = self
            .get_environment_plan_review(&project_root, plan_id)?
            .ok_or_else(|| StoreError::Validation("Environment plan is not materialized".into()))?;
        if changed == 0
            && (record.status != "dispatched"
                || record.approval_lease_id.as_deref() != Some(approval_lease_id)
                || record.operation_id.as_deref() != Some(operation_id))
        {
            return Err(StoreError::Validation(
                "Environment plan has no matching exact approval".to_string(),
            ));
        }
        Ok(record)
    }

    pub fn active_environment_operation(
        &self,
        project_root: &str,
    ) -> Result<Option<EnvironmentOperationActivity>, StoreError> {
        let project_root = required_root(project_root)?;
        self.connection
            .query_row(
                "SELECT operation_id, status
                 FROM environment_operation_journal
                 WHERE project_root = ?1
                   AND status IN ('prepared', 'running', 'verifying', 'uncertain', 'reconcile_required')
                 ORDER BY updated_at DESC, operation_id DESC
                 LIMIT 1",
                [project_root],
                |row| {
                    Ok(EnvironmentOperationActivity {
                        operation_id: row.get(0)?,
                        status: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn begin_environment_operation(
        &mut self,
        project_root: &str,
        plan: &MaterializedPackagePlanV1,
        operation_id: &str,
    ) -> Result<EnvironmentOperationJournalRecord, StoreError> {
        let project_root = required_root(project_root)?;
        plan.validate()
            .map_err(|error| StoreError::Validation(error.to_string()))?;
        let environment_id = plan.body.environment.environment_id.as_str();
        let plan_id = plan.plan_id.as_str();
        let canonical_plan_json = serde_json::to_string(plan)?;
        for (label, value) in [
            ("environment_id", environment_id),
            ("plan_id", plan_id),
            ("operation_id", operation_id),
        ] {
            if value.is_empty() || value.trim() != value || value.chars().any(char::is_control) {
                return Err(StoreError::Validation(format!(
                    "Environment operation {label} is invalid"
                )));
            }
        }
        if let Some(existing_operation_id) =
            self.current_environment_operation_id(&project_root, plan_id)?
        {
            if existing_operation_id != operation_id {
                return Err(StoreError::Validation(
                    "Environment plan is already bound to another operation".to_string(),
                ));
            }
            let existing = self
                .get_environment_operation_journal(&project_root, operation_id)?
                .ok_or_else(|| {
                    StoreError::Validation(
                        "Environment operation plan index is inconsistent".to_string(),
                    )
                })?;
            if existing.environment_id != environment_id || existing.plan != *plan {
                return Err(StoreError::Validation(
                    "Environment operation identity was reused for another Environment".to_string(),
                ));
            }
            return Ok(existing);
        }
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO environment_operation_journal(
                operation_id, project_root, environment_id, plan_id, canonical_plan_json,
                status, next_checkpoint_sequence, reason, created_at, updated_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, 'prepared', 0, NULL, ?6, ?6)
             ON CONFLICT(operation_id) DO NOTHING",
            params![
                operation_id,
                project_root,
                environment_id,
                plan_id,
                canonical_plan_json,
                now
            ],
        )?;
        let current = self
            .get_environment_operation_journal(&project_root, operation_id)?
            .ok_or_else(|| {
                StoreError::Validation(
                    "Environment operation journal insert disappeared".to_string(),
                )
            })?;
        if current.environment_id != environment_id
            || current.plan_id != plan_id
            || current.plan != *plan
        {
            return Err(StoreError::Validation(
                "Environment operation identity was reused for another plan".to_string(),
            ));
        }
        Ok(current)
    }

    pub fn current_environment_operation_id(
        &self,
        project_root: &str,
        plan_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let project_root = required_root(project_root)?;
        if plan_id.is_empty() || plan_id.trim() != plan_id || plan_id.chars().any(char::is_control)
        {
            return Err(StoreError::Validation(
                "Environment operation plan_id is invalid".to_string(),
            ));
        }
        self.connection
            .query_row(
                "SELECT operation_id FROM environment_operation_journal
                 WHERE project_root = ?1 AND plan_id = ?2",
                params![project_root, plan_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn append_environment_checkpoint(
        &mut self,
        project_root: &str,
        operation_id: &str,
        checkpoint: &EnvironmentCheckpointV1,
    ) -> Result<u64, StoreError> {
        let project_root = required_root(project_root)?;
        if checkpoint.name.is_empty()
            || checkpoint.name.trim() != checkpoint.name
            || checkpoint.name.chars().any(char::is_control)
        {
            return Err(StoreError::Validation(
                "Environment checkpoint name is invalid".to_string(),
            ));
        }
        let transaction = self.connection.transaction()?;
        let (status, next): (String, i64) = transaction.query_row(
            "SELECT status, next_checkpoint_sequence
             FROM environment_operation_journal
             WHERE operation_id = ?1 AND project_root = ?2",
            params![operation_id, project_root],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if matches!(status.as_str(), "succeeded" | "failed" | "cancelled") {
            return Err(StoreError::Validation(
                "terminal Environment operation cannot append a checkpoint".to_string(),
            ));
        }
        transaction.execute(
            "INSERT INTO environment_operation_checkpoints(
                operation_id, sequence, name, digest, reached_at
             ) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![
                operation_id,
                next,
                checkpoint.name,
                checkpoint.digest.as_ref().map(AuthorityDigest::as_str),
                checkpoint.reached_at,
            ],
        )?;
        transaction.execute(
            "UPDATE environment_operation_journal
             SET next_checkpoint_sequence = ?2, updated_at = ?3
             WHERE operation_id = ?1",
            params![operation_id, next + 1, checkpoint.reached_at],
        )?;
        transaction.commit()?;
        u64::try_from(next)
            .map_err(|_| StoreError::Validation("negative checkpoint sequence".to_string()))
    }

    pub fn transition_environment_operation(
        &mut self,
        project_root: &str,
        operation_id: &str,
        next: &str,
        reason: Option<&str>,
    ) -> Result<EnvironmentOperationJournalRecord, StoreError> {
        let project_root = required_root(project_root)?;
        let current = self
            .get_environment_operation_journal(&project_root, operation_id)?
            .ok_or_else(|| {
                StoreError::Validation("Environment operation is missing".to_string())
            })?;
        if !allowed_environment_transition(&current.status, next) {
            return Err(StoreError::Validation(format!(
                "illegal Environment operation transition {} -> {next}",
                current.status
            )));
        }
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "UPDATE environment_operation_journal
             SET status = ?3, reason = ?4, updated_at = ?5
             WHERE operation_id = ?1 AND project_root = ?2",
            params![operation_id, project_root, next, reason, now],
        )?;
        self.get_environment_operation_journal(&project_root, operation_id)?
            .ok_or_else(|| StoreError::Validation("Environment operation disappeared".to_string()))
    }

    pub fn get_environment_operation_journal(
        &self,
        project_root: &str,
        operation_id: &str,
    ) -> Result<Option<EnvironmentOperationJournalRecord>, StoreError> {
        let project_root = required_root(project_root)?;
        let head = self
            .connection
            .query_row(
                "SELECT environment_id, plan_id, canonical_plan_json, status, reason,
                        created_at, updated_at
                 FROM environment_operation_journal
                 WHERE operation_id = ?1 AND project_root = ?2",
                params![operation_id, project_root],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((environment_id, plan_id, plan_json, status, reason, created_at, updated_at)) =
            head
        else {
            return Ok(None);
        };
        let plan: MaterializedPackagePlanV1 = serde_json::from_str(&plan_json)?;
        plan.validate()
            .map_err(|error| StoreError::Validation(error.to_string()))?;
        let mut statement = self.connection.prepare(
            "SELECT name, digest, reached_at
             FROM environment_operation_checkpoints
             WHERE operation_id = ?1 ORDER BY sequence",
        )?;
        let rows = statement.query_map([operation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut checkpoints = Vec::new();
        for row in rows {
            let (name, digest, reached_at) = row?;
            checkpoints.push(EnvironmentCheckpointV1 {
                name,
                reached_at,
                digest: digest
                    .map(AuthorityDigest::new)
                    .transpose()
                    .map_err(|error| StoreError::Validation(error.to_string()))?,
            });
        }
        Ok(Some(EnvironmentOperationJournalRecord {
            operation_id: operation_id.to_string(),
            project_root,
            environment_id,
            plan_id,
            plan,
            status,
            checkpoints,
            reason,
            created_at,
            updated_at,
        }))
    }

    pub fn latest_environment_operation_journal(
        &self,
        project_root: &str,
    ) -> Result<Option<EnvironmentOperationJournalRecord>, StoreError> {
        let project_root = required_root(project_root)?;
        let operation_id = self
            .connection
            .query_row(
                "SELECT operation_id FROM environment_operation_journal
                 WHERE project_root = ?1
                 ORDER BY updated_at DESC, operation_id DESC LIMIT 1",
                [&project_root],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        operation_id
            .map(|operation_id| {
                self.get_environment_operation_journal(&project_root, &operation_id)
                    .and_then(|record| {
                        record.ok_or_else(|| {
                            StoreError::Validation(
                                "latest Environment operation disappeared".to_string(),
                            )
                        })
                    })
            })
            .transpose()
    }

    pub fn recover_environment_operations_after_restart(
        &mut self,
        project_root: &str,
    ) -> Result<usize, StoreError> {
        let project_root = required_root(project_root)?;
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "UPDATE environment_operation_journal
                 SET status = 'reconcile_required',
                     reason = COALESCE(reason, 'Desktop restarted before a terminal Environment receipt was committed'),
                     updated_at = ?2
                 WHERE project_root = ?1
                   AND status IN ('prepared', 'running', 'verifying', 'uncertain')",
                params![project_root, now],
            )
            .map_err(StoreError::from)
    }

    pub fn commit_environment_state(
        &mut self,
        commit: &EnvironmentStateCommit,
    ) -> Result<EnvironmentStateProjection, StoreError> {
        let prepared = prepare_environment_commit(commit)?;
        let transaction = self.connection.transaction()?;
        write_environment_state(&transaction, commit, &prepared)?;
        transaction.commit()?;
        Ok(environment_projection(commit, &prepared))
    }

    pub fn commit_environment_state_for_operation(
        &mut self,
        commit: &EnvironmentStateCommit,
        operation_id: &str,
    ) -> Result<EnvironmentStateProjection, StoreError> {
        let prepared = prepare_environment_commit(commit)?;
        if commit.receipt.operation_id.as_str() != operation_id {
            return Err(StoreError::Validation(
                "Environment receipt operation does not match the journal".to_string(),
            ));
        }
        let transaction = self.connection.transaction()?;
        let (environment_id, plan_id, status, next_checkpoint): (String, String, String, i64) =
            transaction.query_row(
                "SELECT environment_id, plan_id, status, next_checkpoint_sequence
                 FROM environment_operation_journal
                 WHERE operation_id = ?1 AND project_root = ?2",
                params![operation_id, prepared.project_root],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        if environment_id != commit.environment.environment_id.as_str()
            || plan_id != commit.receipt.plan_id.as_str()
            || status != "verifying"
        {
            return Err(StoreError::Validation(
                "Environment journal is not the verifying operation for this commit".to_string(),
            ));
        }
        write_environment_state(&transaction, commit, &prepared)?;
        transaction.execute(
            "INSERT INTO environment_operation_checkpoints(
                operation_id, sequence, name, digest, reached_at
             ) VALUES(?1, ?2, 'committed', ?3, ?4)",
            params![
                operation_id,
                next_checkpoint,
                commit.binding.receipt_digest.as_str(),
                prepared.now,
            ],
        )?;
        transaction.execute(
            "UPDATE environment_operation_journal
             SET status = 'succeeded', next_checkpoint_sequence = ?2,
                 reason = NULL, updated_at = ?3
             WHERE operation_id = ?1 AND status = 'verifying'",
            params![operation_id, next_checkpoint + 1, prepared.now],
        )?;
        transaction.commit()?;
        Ok(environment_projection(commit, &prepared))
    }

    pub fn current_environment_state(
        &self,
        project_root: &str,
    ) -> Result<Option<EnvironmentStateProjection>, StoreError> {
        let project_root = required_root(project_root)?;
        let binding = self
            .connection
            .query_row(
                "SELECT environment_id, desired_revision, realization_revision,
                        receipt_id, receipt_digest, updated_at
                 FROM workspace_environment_bindings WHERE project_root = ?1",
                [&project_root],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            environment_id,
            desired_id,
            realization_id,
            receipt_id,
            receipt_digest,
            updated_at,
        )) = binding
        else {
            return Ok(None);
        };
        let environment_json: String = self.connection.query_row(
            "SELECT canonical_json FROM environment_snapshots
             WHERE snapshot_id = ?1 AND project_root = ?2",
            params![environment_id, project_root],
            |row| row.get(0),
        )?;
        let environment_value: serde_json::Value = serde_json::from_str(&environment_json)?;
        let environment: EnvironmentIdentityV1 =
            serde_json::from_value(environment_value.get("environment").cloned().ok_or_else(
                || StoreError::Validation("Environment snapshot has no identity".to_string()),
            )?)?;
        let desired: EnvironmentDesiredRevisionV1 = read_revision(
            &self.connection,
            "environment_desired_revisions",
            &desired_id,
            &project_root,
        )?;
        let realization: EnvironmentRealizationRevisionV1 = read_revision(
            &self.connection,
            "environment_realization_revisions",
            &realization_id,
            &project_root,
        )?;
        let receipt: EnvironmentOperationReceiptV1 = self
            .connection
            .query_row(
                "SELECT canonical_json FROM environment_operation_receipts
             WHERE receipt_id = ?1 AND project_root = ?2",
                params![receipt_id, project_root],
                |row| row.get::<_, String>(0),
            )
            .map_err(StoreError::from)
            .and_then(|json| Ok(serde_json::from_str(&json)?))?;
        let binding = WorkspaceEnvironmentBindingV1 {
            environment_id: environment.environment_id.clone(),
            desired_revision: desired.revision_id.clone(),
            realization_revision: realization.revision_id.clone(),
            receipt_digest: AuthorityDigest::new(receipt_digest)
                .map_err(|error| StoreError::Validation(error.to_string()))?,
        };
        Ok(Some(EnvironmentStateProjection {
            project_root,
            environment,
            desired,
            realization,
            receipt,
            binding,
            updated_at,
        }))
    }

    pub fn record_environment_incident(
        &mut self,
        project_root: &str,
        incident: &EnvironmentIncidentV1,
    ) -> Result<EnvironmentIncidentRecord, StoreError> {
        let project_root = required_root(project_root)?;
        if incident.environment_id.as_str().is_empty()
            || incident.incident_id.trim() != incident.incident_id
            || incident.incident_id.is_empty()
            || incident.kind.trim() != incident.kind
            || incident.kind.is_empty()
        {
            return Err(StoreError::Validation(
                "Environment incident identity is invalid".to_string(),
            ));
        }
        let canonical_json = serde_json::to_string(incident)?;
        self.connection.execute(
            "INSERT INTO environment_incidents(
                incident_id, project_root, environment_id, kind, status,
                canonical_json, detected_at, resolved_at
             ) VALUES(?1, ?2, ?3, ?4, 'open', ?5, ?6, NULL)
             ON CONFLICT(incident_id) DO UPDATE SET
                status = 'open', detected_at = excluded.detected_at, resolved_at = NULL
             WHERE environment_incidents.project_root = excluded.project_root
               AND environment_incidents.environment_id = excluded.environment_id
               AND environment_incidents.canonical_json = excluded.canonical_json",
            params![
                incident.incident_id,
                project_root,
                incident.environment_id.as_str(),
                incident.kind,
                canonical_json,
                incident.detected_at,
            ],
        )?;
        let stored: String = self.connection.query_row(
            "SELECT canonical_json FROM environment_incidents
             WHERE incident_id = ?1 AND project_root = ?2",
            params![incident.incident_id, project_root],
            |row| row.get(0),
        )?;
        if stored != canonical_json {
            return Err(StoreError::Validation(
                "Environment incident identity was reused with different content".to_string(),
            ));
        }
        Ok(EnvironmentIncidentRecord {
            project_root,
            incident: incident.clone(),
            status: "open".to_string(),
            resolved_at: None,
        })
    }

    pub fn resolve_environment_incident(
        &mut self,
        project_root: &str,
        environment_id: &str,
        incident_id: &str,
        resolved_at: &str,
    ) -> Result<usize, StoreError> {
        let project_root = required_root(project_root)?;
        if environment_id.is_empty()
            || environment_id.trim() != environment_id
            || incident_id.is_empty()
            || incident_id.trim() != incident_id
            || resolved_at.is_empty()
            || resolved_at.trim() != resolved_at
        {
            return Err(StoreError::Validation(
                "Environment incident resolution identity is invalid".to_string(),
            ));
        }
        self.connection
            .execute(
                "UPDATE environment_incidents
                 SET status = 'resolved', resolved_at = ?3
                 WHERE project_root = ?1 AND environment_id = ?2
                   AND incident_id = ?4 AND status = 'open'",
                params![project_root, environment_id, resolved_at, incident_id],
            )
            .map_err(StoreError::from)
    }

    pub fn list_environment_incidents(
        &self,
        project_root: &str,
        include_resolved: bool,
        limit: usize,
    ) -> Result<Vec<EnvironmentIncidentRecord>, StoreError> {
        let project_root = required_root(project_root)?;
        if limit == 0 || limit > 500 {
            return Err(StoreError::Validation(
                "Environment incident limit must be between 1 and 500".to_string(),
            ));
        }
        let mut statement = self.connection.prepare(
            "SELECT canonical_json, status, resolved_at FROM environment_incidents
             WHERE project_root = ?1 AND (?2 = 1 OR status = 'open')
             ORDER BY detected_at DESC, incident_id ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![project_root, i64::from(include_resolved), limit as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?;
        rows.map(|row| {
            let (json, status, resolved_at) = row?;
            Ok(EnvironmentIncidentRecord {
                project_root: project_root.clone(),
                incident: serde_json::from_str(&json)?,
                status,
                resolved_at,
            })
        })
        .collect()
    }
}

struct PreparedEnvironmentCommit {
    project_root: String,
    desired_json: String,
    realization_json: String,
    receipt_json: String,
    desired_digest: AuthorityDigest,
    realization_digest: AuthorityDigest,
    snapshot_json: String,
    now: String,
}

fn prepare_environment_commit(
    commit: &EnvironmentStateCommit,
) -> Result<PreparedEnvironmentCommit, StoreError> {
    let project_root = required_root(&commit.project_root)?;
    commit
        .receipt
        .validate()
        .map_err(|error| StoreError::Validation(error.to_string()))?;
    validate_commit(commit)?;
    let desired_json = serde_json::to_string(&commit.desired)?;
    let realization_json = serde_json::to_string(&commit.realization)?;
    let receipt_json = serde_json::to_string(&commit.receipt)?;
    let environment_json = serde_json::to_string(&commit.environment)?;
    let desired_digest = canonical_digest(desired_json.as_bytes())?;
    let realization_digest = canonical_digest(realization_json.as_bytes())?;
    let receipt_digest = canonical_digest(receipt_json.as_bytes())?;
    if receipt_digest != commit.binding.receipt_digest {
        return Err(StoreError::Validation(
            "Workspace Environment binding receipt digest does not match the receipt".to_string(),
        ));
    }
    let snapshot_json = serde_json::to_string(&serde_json::json!({
        "environment": serde_json::from_str::<serde_json::Value>(&environment_json)?,
        "desired": serde_json::from_str::<serde_json::Value>(&desired_json)?,
        "realization": serde_json::from_str::<serde_json::Value>(&realization_json)?,
        "binding": &commit.binding,
        "receipt_id": commit.receipt.receipt_id,
    }))?;
    Ok(PreparedEnvironmentCommit {
        project_root,
        desired_json,
        realization_json,
        receipt_json,
        desired_digest,
        realization_digest,
        snapshot_json,
        now: Utc::now().to_rfc3339(),
    })
}

fn decode_environment_plan_review(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<EnvironmentPlanReviewRecord> {
    let canonical_plan_json: String = row.get(1)?;
    let plan: MaterializedPackagePlanV1 =
        serde_json::from_str(&canonical_plan_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
        })?;
    plan.validate().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
    })?;
    Ok(EnvironmentPlanReviewRecord {
        project_root: row.get(0)?,
        plan,
        status: row.get(2)?,
        approval_lease_id: row.get(3)?,
        operation_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn write_environment_state(
    transaction: &Transaction<'_>,
    commit: &EnvironmentStateCommit,
    prepared: &PreparedEnvironmentCommit,
) -> Result<(), StoreError> {
    let previous = transaction
        .query_row(
            "SELECT environment_id, desired_revision, realization_revision
             FROM workspace_environment_bindings WHERE project_root = ?1",
            [&prepared.project_root],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((environment_id, desired_revision, realization_revision)) = previous
        && (environment_id != commit.environment.environment_id.as_str()
            || desired_revision != commit.receipt.desired_before.as_str()
            || realization_revision != commit.receipt.realization_before.as_str())
    {
        return Err(StoreError::Validation(
            "Environment state changed after the approved plan was materialized".to_string(),
        ));
    }
    insert_immutable_revision(
        transaction,
        "environment_desired_revisions",
        commit.desired.revision_id.as_str(),
        &prepared.project_root,
        commit.environment.environment_id.as_str(),
        &prepared.desired_json,
        prepared.desired_digest.as_str(),
        &prepared.now,
    )?;
    insert_immutable_revision(
        transaction,
        "environment_realization_revisions",
        commit.realization.revision_id.as_str(),
        &prepared.project_root,
        commit.environment.environment_id.as_str(),
        &prepared.realization_json,
        prepared.realization_digest.as_str(),
        &prepared.now,
    )?;
    insert_immutable_receipt(
        transaction,
        &prepared.project_root,
        commit.environment.environment_id.as_str(),
        &commit.receipt,
        &prepared.receipt_json,
    )?;
    transaction.execute(
        "INSERT INTO workspace_environment_bindings(
            project_root, environment_id, desired_revision, realization_revision,
            receipt_id, receipt_digest, updated_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project_root) DO UPDATE SET
            environment_id = excluded.environment_id,
            desired_revision = excluded.desired_revision,
            realization_revision = excluded.realization_revision,
            receipt_id = excluded.receipt_id,
            receipt_digest = excluded.receipt_digest,
            updated_at = excluded.updated_at",
        params![
            prepared.project_root,
            commit.environment.environment_id.as_str(),
            commit.desired.revision_id.as_str(),
            commit.realization.revision_id.as_str(),
            commit.receipt.receipt_id.as_str(),
            commit.binding.receipt_digest.as_str(),
            prepared.now,
        ],
    )?;
    transaction.execute(
        "INSERT INTO environment_snapshots(
            snapshot_id, project_root, canonical_json, first_captured_at, last_captured_at
         ) VALUES(?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(snapshot_id) DO UPDATE SET
            project_root = excluded.project_root,
            canonical_json = excluded.canonical_json,
            last_captured_at = excluded.last_captured_at",
        params![
            commit.environment.environment_id.as_str(),
            prepared.project_root,
            prepared.snapshot_json,
            prepared.now,
        ],
    )?;
    Ok(())
}

fn environment_projection(
    commit: &EnvironmentStateCommit,
    prepared: &PreparedEnvironmentCommit,
) -> EnvironmentStateProjection {
    EnvironmentStateProjection {
        project_root: prepared.project_root.clone(),
        environment: commit.environment.clone(),
        desired: commit.desired.clone(),
        realization: commit.realization.clone(),
        receipt: commit.receipt.clone(),
        binding: commit.binding.clone(),
        updated_at: prepared.now.clone(),
    }
}

fn validate_commit(commit: &EnvironmentStateCommit) -> Result<(), StoreError> {
    if commit.environment.environment_id != commit.binding.environment_id
        || commit.desired.revision_id != commit.binding.desired_revision
        || commit.realization.revision_id != commit.binding.realization_revision
        || commit.receipt.desired_after.as_ref() != Some(&commit.desired.revision_id)
        || commit.receipt.realization_after.as_ref() != Some(&commit.realization.revision_id)
        || commit.receipt.outcome != EnvironmentOperationOutcomeV1::Succeeded
    {
        return Err(StoreError::Validation(
            "Environment state commit identities or successful outcome do not agree".to_string(),
        ));
    }
    if let Some(project_id) = commit.environment.project_id.as_ref() {
        if project_id.as_str().is_empty() {
            return Err(StoreError::Validation(
                "Environment project identity is empty".to_string(),
            ));
        }
    }
    Ok(())
}

fn allowed_environment_transition(current: &str, next: &str) -> bool {
    current == next
        || matches!(
            (current, next),
            ("prepared", "running")
                | ("prepared", "cancelled")
                | ("running", "verifying")
                | ("running", "failed")
                | ("running", "cancelled")
                | ("running", "uncertain")
                | ("uncertain", "reconcile_required")
                | ("reconcile_required", "running")
                | ("reconcile_required", "failed")
                | ("reconcile_required", "cancelled")
                | ("verifying", "succeeded")
                | ("verifying", "failed")
        )
}

fn insert_immutable_revision(
    transaction: &Transaction<'_>,
    table: &str,
    revision_id: &str,
    project_root: &str,
    environment_id: &str,
    canonical_json: &str,
    canonical_digest: &str,
    created_at: &str,
) -> Result<(), StoreError> {
    let sql = match table {
        "environment_desired_revisions" => {
            "INSERT INTO environment_desired_revisions(
                revision_id, project_root, environment_id, canonical_json,
                canonical_digest, created_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(revision_id) DO NOTHING"
        }
        "environment_realization_revisions" => {
            "INSERT INTO environment_realization_revisions(
                revision_id, project_root, environment_id, canonical_json,
                canonical_digest, created_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(revision_id) DO NOTHING"
        }
        _ => {
            return Err(StoreError::Validation(
                "Unknown Environment revision table".to_string(),
            ));
        }
    };
    transaction.execute(
        sql,
        params![
            revision_id,
            project_root,
            environment_id,
            canonical_json,
            canonical_digest,
            created_at,
        ],
    )?;
    let stored: (String, String, String) = transaction.query_row(
        &format!(
            "SELECT project_root, environment_id, canonical_json FROM {table} WHERE revision_id = ?1"
        ),
        [revision_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if stored
        != (
            project_root.to_string(),
            environment_id.to_string(),
            canonical_json.to_string(),
        )
    {
        return Err(StoreError::Validation(
            "Environment revision identity was reused with different content".to_string(),
        ));
    }
    Ok(())
}

fn insert_immutable_receipt(
    transaction: &Transaction<'_>,
    project_root: &str,
    environment_id: &str,
    receipt: &EnvironmentOperationReceiptV1,
    canonical_json: &str,
) -> Result<(), StoreError> {
    let outcome = match receipt.outcome {
        EnvironmentOperationOutcomeV1::Succeeded => "succeeded",
        EnvironmentOperationOutcomeV1::Failed => "failed",
        EnvironmentOperationOutcomeV1::Cancelled => "cancelled",
        EnvironmentOperationOutcomeV1::Uncertain => "uncertain",
        EnvironmentOperationOutcomeV1::ReconcileRequired => "reconcile_required",
    };
    transaction.execute(
        "INSERT INTO environment_operation_receipts(
            receipt_id, operation_id, project_root, environment_id, plan_id,
            outcome, canonical_json, recorded_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(receipt_id) DO NOTHING",
        params![
            receipt.receipt_id.as_str(),
            receipt.operation_id.as_str(),
            project_root,
            environment_id,
            receipt.plan_id.as_str(),
            outcome,
            canonical_json,
            receipt.recorded_at,
        ],
    )?;
    let stored: (String, String, String) = transaction.query_row(
        "SELECT project_root, environment_id, canonical_json
         FROM environment_operation_receipts WHERE receipt_id = ?1",
        [receipt.receipt_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if stored
        != (
            project_root.to_string(),
            environment_id.to_string(),
            canonical_json.to_string(),
        )
    {
        return Err(StoreError::Validation(
            "Environment receipt identity was reused with different content".to_string(),
        ));
    }
    Ok(())
}

fn read_revision<T: serde::de::DeserializeOwned>(
    connection: &rusqlite::Connection,
    table: &str,
    revision_id: &str,
    project_root: &str,
) -> Result<T, StoreError> {
    let table = match table {
        "environment_desired_revisions" => "environment_desired_revisions",
        "environment_realization_revisions" => "environment_realization_revisions",
        _ => {
            return Err(StoreError::Validation(
                "Unknown Environment revision table".to_string(),
            ));
        }
    };
    let json: String = connection.query_row(
        &format!("SELECT canonical_json FROM {table} WHERE revision_id = ?1 AND project_root = ?2"),
        params![revision_id, project_root],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&json)?)
}

fn required_root(root: &str) -> Result<String, StoreError> {
    let root = normalize_project_root(root);
    if root.is_empty() {
        return Err(StoreError::Validation(
            "Environment project root must not be empty".to_string(),
        ));
    }
    Ok(root)
}

fn canonical_digest(bytes: &[u8]) -> Result<AuthorityDigest, StoreError> {
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| StoreError::Validation(error.to_string()))
}

#[cfg(test)]
mod tests {
    use rho_protocol::{
        EnvironmentCheckpointV1, EnvironmentDesiredRevisionId, EnvironmentId,
        EnvironmentOperationOutcomeV1, EnvironmentPlanId, EnvironmentRealizationRevisionId,
        EnvironmentReceiptId, EnvironmentRoleV1, ExecutionProfileId, OperationId, ProjectId,
        RuntimeRealizationId,
    };
    use tempfile::tempdir;

    use super::*;

    fn digest(value: char) -> AuthorityDigest {
        AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
    }

    fn commit(project_root: &str) -> EnvironmentStateCommit {
        let environment_id = EnvironmentId::new("environment_store_test").unwrap();
        let desired = EnvironmentDesiredRevisionV1 {
            revision_id: EnvironmentDesiredRevisionId::new("env_desired_store_after").unwrap(),
            core_manifest_digest: None,
            renv_lock_digest: None,
            repository_profile_digest: digest('a'),
            execution_profile_digest: digest('b'),
            ownership_policy_digest: digest('c'),
        };
        let realization = EnvironmentRealizationRevisionV1 {
            revision_id: EnvironmentRealizationRevisionId::new("env_realized_store_after").unwrap(),
            runtime_id: RuntimeRealizationId::new("runtime_realization_store").unwrap(),
            library_stack_digest: digest('d'),
            package_inventory_digest: digest('e'),
            native_fingerprint: digest('f'),
            target_realization_digest: digest('1'),
        };
        let receipt = EnvironmentOperationReceiptV1 {
            receipt_id: EnvironmentReceiptId::new("environment_receipt_store").unwrap(),
            operation_id: OperationId::new("operation_environment_store").unwrap(),
            plan_id: EnvironmentPlanId::new("environment_plan_store").unwrap(),
            actor_id: "user".to_string(),
            approval_effect_digest: digest('2'),
            desired_before: EnvironmentDesiredRevisionId::new("env_desired_store_before").unwrap(),
            desired_after: Some(desired.revision_id.clone()),
            realization_before: EnvironmentRealizationRevisionId::new("env_realized_store_before")
                .unwrap(),
            realization_after: Some(realization.revision_id.clone()),
            checkpoints: vec![EnvironmentCheckpointV1 {
                name: "verified".to_string(),
                reached_at: "2026-09-01T12:00:00Z".to_string(),
                digest: Some(digest('3')),
            }],
            execution_refs: Vec::new(),
            verification_refs: vec!["environment-verification:store".to_string()],
            outcome: EnvironmentOperationOutcomeV1::Succeeded,
            partial_effects_possible: false,
            restart_required: true,
            recorded_at: "2026-09-01T12:00:01Z".to_string(),
        };
        let receipt_json = serde_json::to_vec(&receipt).unwrap();
        let binding = WorkspaceEnvironmentBindingV1 {
            environment_id: environment_id.clone(),
            desired_revision: desired.revision_id.clone(),
            realization_revision: realization.revision_id.clone(),
            receipt_digest: canonical_digest(&receipt_json).unwrap(),
        };
        EnvironmentStateCommit {
            project_root: project_root.to_string(),
            environment: EnvironmentIdentityV1 {
                environment_id,
                role: EnvironmentRoleV1::NativeUser,
                project_id: Some(ProjectId::new("project_store_environment").unwrap()),
                target_id: "local".to_string(),
                execution_profile_id: ExecutionProfileId::new("execution_profile_store").unwrap(),
            },
            desired,
            realization,
            receipt,
            binding,
        }
    }

    #[test]
    fn verified_environment_state_commits_atomically_and_reopens() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let project = "/projects/environment-a";
        let expected = commit(project);
        let mut store = Store::open(&database).unwrap();
        let committed = store.commit_environment_state(&expected).unwrap();
        assert_eq!(committed.binding, expected.binding);
        let batch = store
            .authority_receipt_batch(
                project,
                &ProjectId::new("project_store_environment").unwrap(),
                0,
                10,
            )
            .unwrap();
        assert!(batch.receipts.iter().any(|receipt| {
            matches!(receipt, rho_protocol::AuthorityReceiptV1::Environment(value)
                if value.reference.authority_id == "environment_store_test")
        }));
        drop(store);

        let mut reopened = Store::open(&database).unwrap();
        let current = reopened
            .current_environment_state(project)
            .unwrap()
            .unwrap();
        assert_eq!(current.environment, expected.environment);
        assert_eq!(current.desired, expected.desired);
        assert_eq!(current.realization, expected.realization);
        assert_eq!(current.receipt, expected.receipt);

        let mut conflicting = expected.clone();
        conflicting.desired.repository_profile_digest = digest('9');
        assert!(reopened.commit_environment_state(&conflicting).is_err());
        assert_eq!(
            reopened
                .current_environment_state(project)
                .unwrap()
                .unwrap()
                .desired,
            expected.desired
        );
    }

    #[test]
    fn incidents_are_project_scoped_and_bounded() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let incident = EnvironmentIncidentV1 {
            incident_id: "environment_incident_missing_package".to_string(),
            environment_id: EnvironmentId::new("environment_store_test").unwrap(),
            kind: "missing_package".to_string(),
            subject: "DESeq2".to_string(),
            detail: "The selected Native User library has no loadable DESeq2 installation."
                .to_string(),
            observed_desired_revision: None,
            observed_realization_revision: None,
            detected_at: "2026-09-01T12:00:00Z".to_string(),
        };
        store
            .record_environment_incident("/projects/environment-a", &incident)
            .unwrap();
        assert_eq!(
            store
                .list_environment_incidents("/projects/environment-a", false, 10)
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .list_environment_incidents("/projects/environment-b", false, 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_environment_incidents("/projects/environment-a", false, 0)
                .is_err()
        );
        assert_eq!(
            store
                .resolve_environment_incident(
                    "/projects/environment-a",
                    incident.environment_id.as_str(),
                    &incident.incident_id,
                    "2026-09-01T12:01:00Z",
                )
                .unwrap(),
            1
        );
        assert!(
            store
                .list_environment_incidents("/projects/environment-a", false, 10)
                .unwrap()
                .is_empty()
        );
        store
            .record_environment_incident("/projects/environment-a", &incident)
            .unwrap();
        assert_eq!(
            store
                .list_environment_incidents("/projects/environment-a", false, 10)
                .unwrap()
                .len(),
            1
        );
    }
}
