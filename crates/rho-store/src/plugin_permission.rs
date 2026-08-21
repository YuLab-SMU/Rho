use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Store, StoreError, normalize_project_root};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;
const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_PURPOSE_BYTES: usize = 2048;
const MAX_REASON_BYTES: usize = 256;
const MAX_CONSTRAINTS_BYTES: usize = 64 * 1024;
const MAX_RECOVERY_RECORDS: usize = 1024;
const ALLOW_ONCE_MAX_SECONDS: i64 = 5 * 60;
const PROJECT_MAX_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginPermissionRequestDraft {
    pub request_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_digest: String,
    pub runtime_kind: String,
    pub permission: String,
    pub constraints_json: String,
    pub constraints_digest: String,
    pub purpose_text: Option<String>,
    pub expected_project_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginPermissionRequest {
    pub request_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_digest: String,
    pub runtime_kind: String,
    pub permission: String,
    pub constraints_json: String,
    pub constraints_digest: String,
    pub purpose_text: Option<String>,
    pub status: String,
    pub requested_at: String,
    pub resolved_at: Option<String>,
    pub decision: Option<String>,
    pub grant_source: Option<String>,
    pub reason_code: Option<String>,
    pub expected_project_revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermissionDecision {
    Deny,
    AllowOnce,
    AllowProject,
}

impl PluginPermissionDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::AllowOnce => "allow_once",
            Self::AllowProject => "allow_project",
        }
    }

    fn grant_source(self) -> Option<&'static str> {
        match self {
            Self::Deny => None,
            Self::AllowOnce => Some("allow_once"),
            Self::AllowProject => Some("project"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginPermissionDecisionDraft {
    pub request_id: String,
    pub project_root: String,
    pub expected_project_revision: i64,
    pub decision: PluginPermissionDecision,
    pub reason_code: Option<String>,
    pub grant_id: Option<String>,
    pub policy_revision: Option<i64>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermissionMutationOutcome {
    Applied,
    Unchanged,
    NotFound,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginPermissionGrant {
    pub grant_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_digest: String,
    pub runtime_kind: String,
    pub permission: String,
    pub constraints_json: String,
    pub constraints_digest: String,
    pub grant_source: String,
    pub policy_revision: i64,
    pub created_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub consumed_at: Option<String>,
    pub status: String,
    pub originating_request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginPermissionEvent {
    pub event_id: String,
    pub project_root: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub request_id: Option<String>,
    pub grant_id: Option<String>,
    pub event_type: String,
    pub status: String,
    pub reason_code: Option<String>,
    pub details_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginPermissionCallEventDraft {
    pub project_root: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub grant_id: Option<String>,
    pub event_type: String,
    pub status: String,
    pub reason_code: Option<String>,
    pub details_json: String,
}

struct ValidatedRequest {
    request_id: String,
    project_root: String,
    plugin_id: String,
    plugin_version: String,
    package_digest: String,
    runtime_kind: String,
    permission: String,
    constraints_json: String,
    constraints_digest: String,
    purpose_text: Option<String>,
    expected_project_revision: i64,
}

impl Store {
    pub fn create_plugin_permission_request(
        &mut self,
        draft: &PluginPermissionRequestDraft,
    ) -> Result<PluginPermissionRequest, StoreError> {
        self.create_plugin_permission_requests(std::slice::from_ref(draft))?
            .pop()
            .ok_or_else(|| {
                StoreError::Validation(
                    "new plugin permission request could not be reloaded".to_string(),
                )
            })
    }

    pub fn create_plugin_permission_requests(
        &mut self,
        drafts: &[PluginPermissionRequestDraft],
    ) -> Result<Vec<PluginPermissionRequest>, StoreError> {
        if drafts.is_empty() || drafts.len() > 64 {
            return Err(StoreError::Validation(
                "plugin permission request batch must contain 1..=64 entries".to_string(),
            ));
        }
        let requests = drafts
            .iter()
            .map(validate_request)
            .collect::<Result<Vec<_>, _>>()?;
        let mut request_ids = std::collections::BTreeSet::new();
        if requests
            .iter()
            .any(|request| !request_ids.insert(request.request_id.as_str()))
        {
            return Err(StoreError::Validation(
                "plugin permission request batch contains duplicate ids".to_string(),
            ));
        }
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for request in &requests {
            transaction.execute(
                "INSERT INTO plugin_permission_requests(
                    request_id, project_root, plugin_id, plugin_version, package_digest,
                    runtime_kind, permission, constraints_json, constraints_digest,
                    purpose_text, status, requested_at, expected_project_revision
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12)",
                params![
                    request.request_id,
                    request.project_root,
                    request.plugin_id,
                    request.plugin_version,
                    request.package_digest,
                    request.runtime_kind,
                    request.permission,
                    request.constraints_json,
                    request.constraints_digest,
                    request.purpose_text,
                    now,
                    request.expected_project_revision,
                ],
            )?;
            insert_event(
                &transaction,
                PermissionEventDraft {
                    project_root: &request.project_root,
                    plugin_id: &request.plugin_id,
                    package_digest: &request.package_digest,
                    request_id: Some(&request.request_id),
                    grant_id: None,
                    event_type: "request_created",
                    status: "pending",
                    reason_code: None,
                    created_at: &now,
                },
            )?;
        }
        transaction.commit()?;
        requests
            .iter()
            .map(|request| {
                self.get_plugin_permission_request(&request.project_root, &request.request_id)?
                    .ok_or_else(|| {
                        StoreError::Validation(
                            "new plugin permission request could not be reloaded".to_string(),
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()
    }

    pub fn get_plugin_permission_request(
        &self,
        project_root: &str,
        request_id: &str,
    ) -> Result<Option<PluginPermissionRequest>, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.connection
            .query_row(
                "SELECT request_id, project_root, plugin_id, plugin_version,
                        package_digest, runtime_kind, permission, constraints_json,
                        constraints_digest, purpose_text, status, requested_at,
                        resolved_at, decision, grant_source, reason_code,
                        expected_project_revision
                 FROM plugin_permission_requests
                 WHERE project_root = ?1 AND request_id = ?2",
                params![project_root, request_id],
                decode_request,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_plugin_permission_requests(
        &self,
        project_root: &str,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<PluginPermissionRequest>, StoreError> {
        let project_root = required_project_root(project_root)?;
        if let Some(status) = status {
            validate_request_status(status)?;
        }
        let mut statement = self.connection.prepare(
            "SELECT request_id, project_root, plugin_id, plugin_version,
                    package_digest, runtime_kind, permission, constraints_json,
                    constraints_digest, purpose_text, status, requested_at,
                    resolved_at, decision, grant_source, reason_code,
                    expected_project_revision
             FROM plugin_permission_requests
             WHERE project_root = ?1 AND (?2 IS NULL OR status = ?2)
             ORDER BY requested_at DESC, request_id
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                project_root,
                status,
                limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as i64
            ],
            decode_request,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn resolve_plugin_permission_request(
        &mut self,
        draft: &PluginPermissionDecisionDraft,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let now = Utc::now();
        self.resolve_plugin_permission_request_at(draft, now)
    }

    fn resolve_plugin_permission_request_at(
        &mut self,
        draft: &PluginPermissionDecisionDraft,
        now: DateTime<Utc>,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(&draft.project_root)?;
        validate_identifier(&draft.request_id, "plugin permission request id")?;
        if draft.expected_project_revision < 0 {
            return Err(StoreError::Validation(
                "plugin permission project revision must be non-negative".to_string(),
            ));
        }
        let reason_code = validate_reason_code(draft.reason_code.as_deref())?;
        let now_text = now.to_rfc3339();

        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT request_id, project_root, plugin_id, plugin_version,
                        package_digest, runtime_kind, permission, constraints_json,
                        constraints_digest, purpose_text, status, requested_at,
                        resolved_at, decision, grant_source, reason_code,
                        expected_project_revision
                 FROM plugin_permission_requests
                 WHERE project_root = ?1 AND request_id = ?2",
                params![project_root, draft.request_id],
                decode_request,
            )
            .optional()?;
        let Some(current) = current else {
            return Ok(PluginPermissionMutationOutcome::NotFound);
        };
        if current.expected_project_revision != draft.expected_project_revision {
            return Ok(PluginPermissionMutationOutcome::Stale);
        }
        if current.status != "pending" {
            return Ok(
                if terminal_decision_matches(&transaction, &current, draft, reason_code.as_deref())?
                {
                    PluginPermissionMutationOutcome::Unchanged
                } else {
                    PluginPermissionMutationOutcome::Stale
                },
            );
        }

        let grant_fields = validate_decision_fields(draft, now)?;
        let decision = draft.decision.as_str();
        let grant_source = draft.decision.grant_source();
        let status = if draft.decision == PluginPermissionDecision::Deny {
            "denied"
        } else {
            "granted"
        };
        let changed = transaction.execute(
            "UPDATE plugin_permission_requests
             SET status = ?3, resolved_at = ?4, decision = ?5,
                 grant_source = ?6, reason_code = ?7
             WHERE project_root = ?1 AND request_id = ?2
               AND status = 'pending' AND expected_project_revision = ?8",
            params![
                project_root,
                draft.request_id,
                status,
                now_text,
                decision,
                grant_source,
                reason_code,
                draft.expected_project_revision,
            ],
        )?;
        if changed != 1 {
            return Ok(PluginPermissionMutationOutcome::Stale);
        }

        let grant_id = if let Some((grant_id, policy_revision, expires_at)) = grant_fields {
            transaction.execute(
                "INSERT INTO plugin_permission_grants(
                    grant_id, project_root, plugin_id, plugin_version, package_digest,
                    runtime_kind, permission, constraints_json, constraints_digest,
                    grant_source, policy_revision, created_at, expires_at, status,
                    originating_request_id
                 ) VALUES(
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    ?12, ?13, 'active', ?14
                 )",
                params![
                    grant_id,
                    current.project_root,
                    current.plugin_id,
                    current.plugin_version,
                    current.package_digest,
                    current.runtime_kind,
                    current.permission,
                    current.constraints_json,
                    current.constraints_digest,
                    grant_source,
                    policy_revision,
                    now_text,
                    expires_at,
                    current.request_id,
                ],
            )?;
            Some(grant_id)
        } else {
            None
        };
        insert_event(
            &transaction,
            PermissionEventDraft {
                project_root: &current.project_root,
                plugin_id: &current.plugin_id,
                package_digest: &current.package_digest,
                request_id: Some(&current.request_id),
                grant_id,
                event_type: if status == "granted" {
                    "request_granted"
                } else {
                    "request_denied"
                },
                status: "completed",
                reason_code: reason_code.as_deref(),
                created_at: &now_text,
            },
        )?;
        transaction.commit()?;
        Ok(PluginPermissionMutationOutcome::Applied)
    }

    pub fn cancel_plugin_permission_request(
        &mut self,
        project_root: &str,
        request_id: &str,
        expected_project_revision: i64,
        reason_code: &str,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        validate_identifier(request_id, "plugin permission request id")?;
        if expected_project_revision < 0 {
            return Err(StoreError::Validation(
                "plugin permission project revision must be non-negative".to_string(),
            ));
        }
        let reason_code = validate_reason_code(Some(reason_code))?.ok_or_else(|| {
            StoreError::Validation("plugin permission cancellation reason is required".to_string())
        })?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT plugin_id, package_digest, status, expected_project_revision
                 FROM plugin_permission_requests
                 WHERE project_root = ?1 AND request_id = ?2",
                params![project_root, request_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((plugin_id, package_digest, status, current_revision)) = current else {
            return Ok(PluginPermissionMutationOutcome::NotFound);
        };
        if current_revision != expected_project_revision {
            return Ok(PluginPermissionMutationOutcome::Stale);
        }
        if status != "pending" {
            return Ok(if status == "cancelled" {
                PluginPermissionMutationOutcome::Unchanged
            } else {
                PluginPermissionMutationOutcome::Stale
            });
        }
        let changed = transaction.execute(
            "UPDATE plugin_permission_requests
             SET status = 'cancelled', resolved_at = ?3, reason_code = ?4
             WHERE project_root = ?1 AND request_id = ?2 AND status = 'pending'",
            params![project_root, request_id, now, reason_code],
        )?;
        if changed != 1 {
            return Ok(PluginPermissionMutationOutcome::Stale);
        }
        insert_event(
            &transaction,
            PermissionEventDraft {
                project_root: &project_root,
                plugin_id: &plugin_id,
                package_digest: &package_digest,
                request_id: Some(request_id),
                grant_id: None,
                event_type: "request_cancelled",
                status: "cancelled",
                reason_code: Some(&reason_code),
                created_at: &now,
            },
        )?;
        transaction.commit()?;
        Ok(PluginPermissionMutationOutcome::Applied)
    }

    pub fn list_plugin_permission_grants(
        &self,
        project_root: &str,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<PluginPermissionGrant>, StoreError> {
        let project_root = required_project_root(project_root)?;
        if let Some(status) = status {
            validate_grant_status(status)?;
        }
        let mut statement = self.connection.prepare(
            "SELECT grant_id, project_root, plugin_id, plugin_version, package_digest,
                    runtime_kind, permission, constraints_json, constraints_digest,
                    grant_source, policy_revision, created_at, expires_at, revoked_at,
                    consumed_at, status, originating_request_id
             FROM plugin_permission_grants
             WHERE project_root = ?1 AND (?2 IS NULL OR status = ?2)
             ORDER BY created_at DESC, grant_id
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                project_root,
                status,
                limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as i64
            ],
            decode_grant,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn revoke_plugin_permission_grant(
        &mut self,
        project_root: &str,
        grant_id: &str,
        reason_code: &str,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        self.transition_grant(
            project_root,
            grant_id,
            "revoked",
            "grant_revoked",
            reason_code,
        )
    }

    pub fn consume_plugin_permission_grant(
        &mut self,
        project_root: &str,
        grant_id: &str,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        validate_identifier(grant_id, "plugin permission grant id")?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current = grant_identity(&transaction, &project_root, grant_id)?;
        let Some((plugin_id, package_digest, status, source)) = current else {
            return Ok(PluginPermissionMutationOutcome::NotFound);
        };
        if status != "active" || source != "allow_once" {
            return Ok(if status == "consumed" {
                PluginPermissionMutationOutcome::Unchanged
            } else {
                PluginPermissionMutationOutcome::Stale
            });
        }
        let changed = transaction.execute(
            "UPDATE plugin_permission_grants
             SET status = 'consumed', consumed_at = ?3
             WHERE project_root = ?1 AND grant_id = ?2 AND status = 'active'",
            params![project_root, grant_id, now],
        )?;
        if changed != 1 {
            return Ok(PluginPermissionMutationOutcome::Stale);
        }
        insert_event(
            &transaction,
            PermissionEventDraft {
                project_root: &project_root,
                plugin_id: &plugin_id,
                package_digest: &package_digest,
                request_id: None,
                grant_id: Some(grant_id),
                event_type: "grant_consumed",
                status: "completed",
                reason_code: None,
                created_at: &now,
            },
        )?;
        transaction.commit()?;
        Ok(PluginPermissionMutationOutcome::Applied)
    }

    fn transition_grant(
        &mut self,
        project_root: &str,
        grant_id: &str,
        next_status: &str,
        event_type: &str,
        reason_code: &str,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        validate_identifier(grant_id, "plugin permission grant id")?;
        let reason_code = validate_reason_code(Some(reason_code))?.ok_or_else(|| {
            StoreError::Validation("plugin permission grant reason is required".to_string())
        })?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current = grant_identity(&transaction, &project_root, grant_id)?;
        let Some((plugin_id, package_digest, status, _source)) = current else {
            return Ok(PluginPermissionMutationOutcome::NotFound);
        };
        if status != "active" {
            return Ok(if status == next_status {
                PluginPermissionMutationOutcome::Unchanged
            } else {
                PluginPermissionMutationOutcome::Stale
            });
        }
        let changed = transaction.execute(
            "UPDATE plugin_permission_grants
             SET status = ?3, revoked_at = CASE WHEN ?3 = 'revoked' THEN ?4 ELSE revoked_at END
             WHERE project_root = ?1 AND grant_id = ?2 AND status = 'active'",
            params![project_root, grant_id, next_status, now],
        )?;
        if changed != 1 {
            return Ok(PluginPermissionMutationOutcome::Stale);
        }
        insert_event(
            &transaction,
            PermissionEventDraft {
                project_root: &project_root,
                plugin_id: &plugin_id,
                package_digest: &package_digest,
                request_id: None,
                grant_id: Some(grant_id),
                event_type,
                status: "completed",
                reason_code: Some(&reason_code),
                created_at: &now,
            },
        )?;
        transaction.commit()?;
        Ok(PluginPermissionMutationOutcome::Applied)
    }

    pub fn recover_pending_plugin_permission_requests(
        &mut self,
        project_root: &str,
        reason_code: &str,
    ) -> Result<usize, StoreError> {
        let project_root = required_project_root(project_root)?;
        let reason_code = validate_reason_code(Some(reason_code))?.ok_or_else(|| {
            StoreError::Validation("plugin permission recovery reason is required".to_string())
        })?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let pending = {
            let mut statement = transaction.prepare(
                "SELECT request_id, plugin_id, package_digest
                 FROM plugin_permission_requests
                 WHERE project_root = ?1 AND status = 'pending'
                 ORDER BY requested_at, request_id",
            )?;
            statement
                .query_map([&project_root], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut recovered = 0;
        for (request_id, plugin_id, package_digest) in &pending {
            let changed = transaction.execute(
                "UPDATE plugin_permission_requests
                 SET status = 'cancelled', resolved_at = ?3, reason_code = ?4
                 WHERE project_root = ?1 AND request_id = ?2 AND status = 'pending'",
                params![project_root, request_id, now, reason_code],
            )?;
            if changed != 1 {
                continue;
            }
            insert_event(
                &transaction,
                PermissionEventDraft {
                    project_root: &project_root,
                    plugin_id,
                    package_digest,
                    request_id: Some(request_id),
                    grant_id: None,
                    event_type: "recovery_cancelled",
                    status: "cancelled",
                    reason_code: Some(&reason_code),
                    created_at: &now,
                },
            )?;
            recovered += 1;
        }
        transaction.commit()?;
        Ok(recovered)
    }

    /// Restart/shutdown recovery for one-shot decisions. A durable allow-once
    /// row is audit evidence, never a reusable authorization after the live
    /// broker session disappears.
    pub fn recover_transient_plugin_permission_grants(
        &mut self,
        project_root: &str,
        reason_code: &str,
    ) -> Result<usize, StoreError> {
        let project_root = required_project_root(project_root)?;
        let reason_code = validate_reason_code(Some(reason_code))?.ok_or_else(|| {
            StoreError::Validation("plugin permission recovery reason is required".to_string())
        })?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let grants = {
            let mut statement = transaction.prepare(
                "SELECT grant_id, plugin_id, package_digest
                 FROM plugin_permission_grants
                 WHERE project_root = ?1 AND status = 'active'
                   AND grant_source = 'allow_once'
                 ORDER BY grant_id ASC
                 LIMIT ?2",
            )?;
            statement
                .query_map(params![project_root, MAX_RECOVERY_RECORDS as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut recovered = 0;
        for (grant_id, plugin_id, package_digest) in grants {
            let changed = transaction.execute(
                "UPDATE plugin_permission_grants
                 SET status = 'revoked', revoked_at = ?3
                 WHERE project_root = ?1 AND grant_id = ?2
                   AND status = 'active' AND grant_source = 'allow_once'",
                params![project_root, grant_id, now],
            )?;
            if changed != 1 {
                continue;
            }
            insert_event(
                &transaction,
                PermissionEventDraft {
                    project_root: &project_root,
                    plugin_id: &plugin_id,
                    package_digest: &package_digest,
                    request_id: None,
                    grant_id: Some(&grant_id),
                    event_type: "grant_revoked",
                    status: "completed",
                    reason_code: Some(&reason_code),
                    created_at: &now,
                },
            )?;
            recovered += 1;
        }
        transaction.commit()?;
        Ok(recovered)
    }

    pub fn expire_plugin_permission_grants(
        &mut self,
        project_root: &str,
    ) -> Result<usize, StoreError> {
        self.expire_plugin_permission_grants_at(project_root, Utc::now())
    }

    fn expire_plugin_permission_grants_at(
        &mut self,
        project_root: &str,
        now: DateTime<Utc>,
    ) -> Result<usize, StoreError> {
        let project_root = required_project_root(project_root)?;
        let now_text = now.to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let active = {
            let mut statement = transaction.prepare(
                "SELECT grant_id, plugin_id, package_digest, expires_at
                 FROM plugin_permission_grants
                 WHERE project_root = ?1 AND status = 'active'
                 ORDER BY expires_at, grant_id
                 LIMIT ?2",
            )?;
            statement
                .query_map(params![project_root, MAX_RECOVERY_RECORDS as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut expired = 0;
        for (grant_id, plugin_id, package_digest, expires_at) in active {
            let expiry = DateTime::parse_from_rfc3339(&expires_at)
                .map_err(|_| {
                    StoreError::Validation(
                        "persisted plugin permission expiry is invalid".to_string(),
                    )
                })?
                .with_timezone(&Utc);
            if expiry > now {
                continue;
            }
            let changed = transaction.execute(
                "UPDATE plugin_permission_grants
                 SET status = 'expired'
                 WHERE project_root = ?1 AND grant_id = ?2 AND status = 'active'",
                params![project_root, grant_id],
            )?;
            if changed != 1 {
                continue;
            }
            insert_event(
                &transaction,
                PermissionEventDraft {
                    project_root: &project_root,
                    plugin_id: &plugin_id,
                    package_digest: &package_digest,
                    request_id: None,
                    grant_id: Some(&grant_id),
                    event_type: "grant_expired",
                    status: "completed",
                    reason_code: None,
                    created_at: &now_text,
                },
            )?;
            expired += 1;
        }
        transaction.commit()?;
        Ok(expired)
    }

    pub fn list_plugin_permission_events(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<PluginPermissionEvent>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let mut statement = self.connection.prepare(
            "SELECT event_id, project_root, plugin_id, package_digest, request_id,
                    grant_id, event_type, status, reason_code, details_json, created_at
             FROM plugin_permission_events
             WHERE project_root = ?1
             ORDER BY created_at DESC, event_id
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![
                project_root,
                limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as i64
            ],
            decode_event,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn record_plugin_permission_call_event(
        &mut self,
        draft: &PluginPermissionCallEventDraft,
        consume_allow_once: bool,
    ) -> Result<String, StoreError> {
        let project_root = required_project_root(&draft.project_root)?;
        let plugin_id = validate_identifier(&draft.plugin_id, "plugin id")?;
        let package_digest = validate_digest(&draft.package_digest, "package digest")?;
        let event_type = validate_call_event_type(&draft.event_type)?;
        let status = validate_call_event_status(&draft.status)?;
        let reason_code = validate_reason_code(draft.reason_code.as_deref())?;
        let details_json = validate_call_details(&draft.details_json)?;
        if consume_allow_once
            && !matches!(
                event_type.as_str(),
                "call_completed" | "completion_uncertain"
            )
        {
            return Err(StoreError::Validation(
                "only completed or uncertain calls may consume an allow-once grant".to_string(),
            ));
        }
        let grant_id = draft
            .grant_id
            .as_deref()
            .map(|grant_id| validate_identifier(grant_id, "plugin permission grant id"))
            .transpose()?;
        let now = Utc::now().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let grant_source = if let Some(grant_id) = grant_id.as_deref() {
            transaction
                .query_row(
                    "SELECT grant_source
                     FROM plugin_permission_grants
                     WHERE project_root = ?1 AND grant_id = ?2
                       AND plugin_id = ?3 AND package_digest = ?4
                       AND status = 'active'",
                    params![project_root, grant_id, plugin_id, package_digest],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| {
                    StoreError::Validation(
                        "plugin permission call grant is missing, stale, or inactive".to_string(),
                    )
                })
                .map(Some)?
        } else {
            None
        };
        let call_event_id = insert_call_event(
            &transaction,
            &PluginPermissionCallEventDraft {
                project_root: project_root.clone(),
                plugin_id: plugin_id.clone(),
                package_digest: package_digest.clone(),
                grant_id: grant_id.clone(),
                event_type: event_type.clone(),
                status,
                reason_code: reason_code.clone(),
                details_json,
            },
            &now,
        )?;
        if consume_allow_once && grant_source.as_deref() == Some("allow_once") {
            let grant_id = grant_id.as_deref().ok_or_else(|| {
                StoreError::Validation(
                    "consuming a plugin permission call requires a grant".to_string(),
                )
            })?;
            let changed = transaction.execute(
                "UPDATE plugin_permission_grants
                 SET status = 'consumed', consumed_at = ?3
                 WHERE project_root = ?1 AND grant_id = ?2
                   AND status = 'active' AND grant_source = 'allow_once'",
                params![project_root, grant_id, now],
            )?;
            if changed != 1 {
                return Err(StoreError::Validation(
                    "allow-once plugin grant changed before completion persisted".to_string(),
                ));
            }
            insert_event(
                &transaction,
                PermissionEventDraft {
                    project_root: &project_root,
                    plugin_id: &plugin_id,
                    package_digest: &package_digest,
                    request_id: None,
                    grant_id: Some(grant_id),
                    event_type: "grant_consumed",
                    status: "completed",
                    reason_code: None,
                    created_at: &now,
                },
            )?;
        }
        transaction.commit()?;
        Ok(call_event_id)
    }
}

fn validate_request(draft: &PluginPermissionRequestDraft) -> Result<ValidatedRequest, StoreError> {
    let request_id = validate_identifier(&draft.request_id, "plugin permission request id")?;
    let project_root = required_project_root(&draft.project_root)?;
    let plugin_id = validate_identifier(&draft.plugin_id, "plugin id")?;
    let plugin_version = draft.plugin_version.trim().to_string();
    if plugin_version.len() > MAX_IDENTIFIER_BYTES
        || semver::Version::parse(&plugin_version).is_err()
    {
        return Err(StoreError::Validation(
            "plugin version must be a bounded semantic version".to_string(),
        ));
    }
    let package_digest = validate_digest(&draft.package_digest, "package digest")?;
    if draft.runtime_kind != "wasm" {
        return Err(StoreError::Validation(
            "plugin permission runtime kind must be wasm".to_string(),
        ));
    }
    validate_permission(&draft.permission)?;
    let (constraints_json, computed_digest) = canonical_constraints(&draft.constraints_json)?;
    let parsed_constraints: serde_json::Value = serde_json::from_str(&constraints_json)?;
    validate_constraint_shape(&draft.permission, &parsed_constraints)?;
    let constraints_digest = validate_digest(&draft.constraints_digest, "constraints digest")?;
    if constraints_digest != computed_digest {
        return Err(StoreError::Validation(
            "plugin permission constraints digest does not match canonical JSON".to_string(),
        ));
    }
    let purpose_text = validate_optional_text(
        draft.purpose_text.as_deref(),
        MAX_PURPOSE_BYTES,
        "plugin permission purpose",
    )?;
    if draft.expected_project_revision < 0 {
        return Err(StoreError::Validation(
            "plugin permission project revision must be non-negative".to_string(),
        ));
    }
    Ok(ValidatedRequest {
        request_id,
        project_root,
        plugin_id,
        plugin_version,
        package_digest,
        runtime_kind: "wasm".to_string(),
        permission: draft.permission.clone(),
        constraints_json,
        constraints_digest,
        purpose_text,
        expected_project_revision: draft.expected_project_revision,
    })
}

fn validate_decision_fields(
    draft: &PluginPermissionDecisionDraft,
    now: DateTime<Utc>,
) -> Result<Option<(&str, i64, String)>, StoreError> {
    match draft.decision {
        PluginPermissionDecision::Deny => {
            if draft.grant_id.is_some()
                || draft.policy_revision.is_some()
                || draft.expires_at.is_some()
            {
                return Err(StoreError::Validation(
                    "denied plugin permission must not create grant fields".to_string(),
                ));
            }
            Ok(None)
        }
        PluginPermissionDecision::AllowOnce | PluginPermissionDecision::AllowProject => {
            let grant_id = draft.grant_id.as_deref().ok_or_else(|| {
                StoreError::Validation("granted plugin permission requires grant id".to_string())
            })?;
            validate_identifier(grant_id, "plugin permission grant id")?;
            let policy_revision = draft
                .policy_revision
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    StoreError::Validation(
                        "granted plugin permission requires positive policy revision".to_string(),
                    )
                })?;
            let expires_at = draft.expires_at.as_deref().ok_or_else(|| {
                StoreError::Validation("granted plugin permission requires expiry".to_string())
            })?;
            let expiry = DateTime::parse_from_rfc3339(expires_at)
                .map_err(|_| StoreError::Validation("plugin grant expiry is invalid".to_string()))?
                .with_timezone(&Utc);
            let maximum = match draft.decision {
                PluginPermissionDecision::AllowOnce => Duration::seconds(ALLOW_ONCE_MAX_SECONDS),
                PluginPermissionDecision::AllowProject => Duration::seconds(PROJECT_MAX_SECONDS),
                PluginPermissionDecision::Deny => unreachable!(),
            };
            if expiry <= now || expiry > now + maximum {
                return Err(StoreError::Validation(
                    "plugin grant expiry exceeds its allowed duration".to_string(),
                ));
            }
            Ok(Some((grant_id, policy_revision, expiry.to_rfc3339())))
        }
    }
}

fn terminal_decision_matches(
    connection: &rusqlite::Connection,
    current: &PluginPermissionRequest,
    draft: &PluginPermissionDecisionDraft,
    reason_code: Option<&str>,
) -> Result<bool, StoreError> {
    if current.decision.as_deref() != Some(draft.decision.as_str())
        || current.reason_code.as_deref() != reason_code
    {
        return Ok(false);
    }
    if draft.decision == PluginPermissionDecision::Deny {
        return Ok(current.status == "denied"
            && current.grant_source.is_none()
            && draft.grant_id.is_none()
            && draft.policy_revision.is_none()
            && draft.expires_at.is_none());
    }
    let existing = connection
        .query_row(
            "SELECT grant_id, policy_revision, expires_at, grant_source
             FROM plugin_permission_grants
             WHERE project_root = ?1 AND originating_request_id = ?2",
            params![current.project_root, current.request_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((grant_id, policy_revision, expires_at, grant_source)) = existing else {
        return Ok(false);
    };
    Ok(current.status == "granted"
        && current.grant_source.as_deref() == draft.decision.grant_source()
        && draft.grant_id.as_deref() == Some(grant_id.as_str())
        && draft.policy_revision == Some(policy_revision)
        && draft.expires_at.as_deref() == Some(expires_at.as_str())
        && draft.decision.grant_source() == Some(grant_source.as_str()))
}

fn required_project_root(project_root: &str) -> Result<String, StoreError> {
    let project_root = normalize_project_root(project_root);
    if project_root.trim().is_empty() || project_root == "legacy_unscoped" {
        Err(StoreError::Validation(
            "plugin permission project root is required".to_string(),
        ))
    } else {
        Ok(project_root)
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(StoreError::Validation(format!(
            "{label} contains invalid or oversized characters"
        )));
    }
    Ok(value.to_string())
}

fn validate_digest(value: &str, label: &str) -> Result<String, StoreError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(StoreError::Validation(format!(
            "{label} must be lowercase hexadecimal SHA-256"
        )));
    }
    Ok(value.to_string())
}

fn validate_permission(permission: &str) -> Result<(), StoreError> {
    if matches!(
        permission,
        "project.fs.read" | "workspace.r.inspect" | "network.fetch"
    ) {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin permission".to_string(),
        ))
    }
}

fn validate_request_status(status: &str) -> Result<(), StoreError> {
    if matches!(
        status,
        "pending" | "granted" | "denied" | "cancelled" | "stale"
    ) {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin permission request status".to_string(),
        ))
    }
}

fn validate_grant_status(status: &str) -> Result<(), StoreError> {
    if matches!(status, "active" | "consumed" | "revoked" | "expired") {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin permission grant status".to_string(),
        ))
    }
}

fn validate_optional_text(
    value: Option<&str>,
    maximum_bytes: usize,
    label: &str,
) -> Result<Option<String>, StoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > maximum_bytes
        || value.chars().any(char::is_control)
        || value.chars().any(is_bidi_override)
    {
        return Err(StoreError::Validation(format!(
            "{label} is oversized or contains control characters"
        )));
    }
    Ok(Some(value.to_string()))
}

fn canonical_constraints(value: &str) -> Result<(String, String), StoreError> {
    if value.len() > MAX_CONSTRAINTS_BYTES {
        return Err(StoreError::Validation(
            "plugin permission constraints are too large".to_string(),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_str(value)?;
    if !parsed.is_object() {
        return Err(StoreError::Validation(
            "plugin permission constraints must be a JSON object".to_string(),
        ));
    }
    let canonical = serde_json::to_string(&parsed)?;
    if canonical.len() > MAX_CONSTRAINTS_BYTES {
        return Err(StoreError::Validation(
            "canonical plugin permission constraints are too large".to_string(),
        ));
    }
    if value != canonical {
        return Err(StoreError::Validation(
            "plugin permission constraints must use canonical JSON encoding".to_string(),
        ));
    }
    let digest = sha256_hex(canonical.as_bytes());
    Ok((canonical, digest))
}

fn validate_reason_code(reason_code: Option<&str>) -> Result<Option<String>, StoreError> {
    let Some(reason_code) = reason_code else {
        return Ok(None);
    };
    let reason_code = reason_code.trim();
    if reason_code.is_empty() {
        return Ok(None);
    }
    if reason_code.len() > MAX_REASON_BYTES
        || !reason_code.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(StoreError::Validation(
            "plugin permission reason code is invalid or oversized".to_string(),
        ));
    }
    Ok(Some(reason_code.to_string()))
}

fn validate_call_event_type(value: &str) -> Result<String, StoreError> {
    if matches!(
        value,
        "handle_minted"
            | "call_admitted"
            | "call_denied"
            | "call_completed"
            | "call_failed"
            | "call_cancelled"
            | "completion_uncertain"
    ) {
        Ok(value.to_string())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin permission call event type".to_string(),
        ))
    }
}

fn validate_call_event_status(value: &str) -> Result<String, StoreError> {
    if matches!(value, "completed" | "failed" | "cancelled" | "stale") {
        Ok(value.to_string())
    } else {
        Err(StoreError::Validation(
            "unsupported plugin permission call event status".to_string(),
        ))
    }
}

fn validate_call_details(value: &str) -> Result<String, StoreError> {
    if value.len() > 8192 {
        return Err(StoreError::Validation(
            "plugin permission call details are too large".to_string(),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_str(value)?;
    let object = parsed.as_object().ok_or_else(|| {
        StoreError::Validation("plugin permission call details must be an object".to_string())
    })?;
    if object.len() > 16 {
        return Err(StoreError::Validation(
            "plugin permission call details contain too many fields".to_string(),
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
                "header",
                "url",
                "content",
                "path",
                "token",
                "secret",
                "workspace_id",
            ]
            .iter()
            .any(|forbidden| lower.contains(forbidden))
        {
            return Err(StoreError::Validation(
                "plugin permission call details contain a forbidden field".to_string(),
            ));
        }
        let valid_value = value.is_null()
            || value.is_boolean()
            || value.is_number()
            || value.as_str().is_some_and(|value| {
                value.len() <= 128
                    && !value.chars().any(char::is_control)
                    && !value.chars().any(is_bidi_override)
                    && !value.contains("handle.")
                    && !value.contains("://")
            });
        if !valid_value {
            return Err(StoreError::Validation(
                "plugin permission call details contain an unsafe value".to_string(),
            ));
        }
    }
    let canonical = serde_json::to_string(&parsed)?;
    if canonical != value {
        return Err(StoreError::Validation(
            "plugin permission call details must use canonical JSON encoding".to_string(),
        ));
    }
    Ok(canonical)
}

fn validate_constraint_shape(
    permission: &str,
    constraints: &serde_json::Value,
) -> Result<(), StoreError> {
    let object = constraints.as_object().ok_or_else(|| {
        StoreError::Validation("plugin permission constraints must be an object".to_string())
    })?;
    let exact_keys = |allowed: &[&str]| {
        object.len() == allowed.len() && object.keys().all(|key| allowed.contains(&key.as_str()))
    };
    let positive_bound = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|value| value > 0 && value <= 1024 * 1024)
    };
    let string_array = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|values| {
                !values.is_empty()
                    && values.len() <= 64
                    && values.iter().all(|value| {
                        value
                            .as_str()
                            .is_some_and(|value| !value.is_empty() && value.len() <= 4096)
                    })
            })
    };
    let valid = match permission {
        "project.fs.read" => {
            exact_keys(&["maxBytes", "paths"])
                && positive_bound("maxBytes")
                && string_array("paths")
                && object["paths"].as_array().unwrap().iter().all(|value| {
                    let path = value.as_str().unwrap();
                    !path.starts_with('/')
                        && !path.starts_with('\\')
                        && !path.contains(':')
                        && !path.contains('\\')
                        && !reserved_path_pattern(path)
                        && !path.split('/').any(|component| {
                            component.is_empty() || component == "." || component == ".."
                        })
                })
        }
        "workspace.r.inspect" => {
            exact_keys(&["maxBytes", "operations"])
                && positive_bound("maxBytes")
                && string_array("operations")
                && object["operations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|value| matches!(value.as_str(), Some("metadata" | "preview")))
        }
        "network.fetch" => {
            exact_keys(&["hosts", "maxResponseBytes", "methods", "schemes"])
                && positive_bound("maxResponseBytes")
                && string_array("hosts")
                && string_array("methods")
                && string_array("schemes")
                && object["schemes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|value| value.as_str() == Some("https"))
                && object["hosts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|value| value.as_str().is_some_and(valid_host_pattern))
                && object["methods"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|value| matches!(value.as_str(), Some("GET" | "HEAD")))
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(StoreError::Validation(
            "plugin permission constraints do not match the permission shape".to_string(),
        ))
    }
}

fn is_bidi_override(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

fn reserved_path_pattern(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let first = lower.split('/').next().unwrap_or_default();
    let last = lower.rsplit('/').next().unwrap_or_default();
    matches!(first, ".git" | ".rho")
        || last == ".env"
        || last.starts_with(".env.")
        || last.eq_ignore_ascii_case(".renviron")
        || matches!(last, "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa")
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| last.ends_with(suffix))
}

fn valid_host_pattern(host: &str) -> bool {
    let domain = host.strip_prefix("*.").unwrap_or(host);
    !domain.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('*')
        && domain.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
}

struct PermissionEventDraft<'a> {
    project_root: &'a str,
    plugin_id: &'a str,
    package_digest: &'a str,
    request_id: Option<&'a str>,
    grant_id: Option<&'a str>,
    event_type: &'a str,
    status: &'a str,
    reason_code: Option<&'a str>,
    created_at: &'a str,
}

fn insert_call_event(
    connection: &rusqlite::Connection,
    event: &PluginPermissionCallEventDraft,
    created_at: &str,
) -> Result<String, StoreError> {
    let event_id = format!("event.{}", uuid::Uuid::new_v4().simple());
    connection.execute(
        "INSERT INTO plugin_permission_events(
            event_id, project_root, plugin_id, package_digest, request_id, grant_id,
            event_type, status, reason_code, details_json, created_at
         ) VALUES(?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &event_id,
            event.project_root,
            event.plugin_id,
            event.package_digest,
            event.grant_id,
            event.event_type,
            event.status,
            event.reason_code,
            event.details_json,
            created_at,
        ],
    )?;
    Ok(event_id)
}

fn insert_event(
    connection: &rusqlite::Connection,
    event: PermissionEventDraft<'_>,
) -> Result<(), StoreError> {
    let event_id = format!("event.{}", uuid::Uuid::new_v4().simple());
    connection.execute(
        "INSERT INTO plugin_permission_events(
            event_id, project_root, plugin_id, package_digest, request_id, grant_id,
            event_type, status, reason_code, details_json, created_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '{}', ?10)",
        params![
            event_id,
            event.project_root,
            event.plugin_id,
            event.package_digest,
            event.request_id,
            event.grant_id,
            event.event_type,
            event.status,
            event.reason_code,
            event.created_at,
        ],
    )?;
    Ok(())
}

fn grant_identity(
    connection: &rusqlite::Connection,
    project_root: &str,
    grant_id: &str,
) -> Result<Option<(String, String, String, String)>, StoreError> {
    connection
        .query_row(
            "SELECT plugin_id, package_digest, status, grant_source
             FROM plugin_permission_grants
             WHERE project_root = ?1 AND grant_id = ?2",
            params![project_root, grant_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(StoreError::from)
}

fn decode_request(row: &Row<'_>) -> rusqlite::Result<PluginPermissionRequest> {
    Ok(PluginPermissionRequest {
        request_id: row.get(0)?,
        project_root: row.get(1)?,
        plugin_id: row.get(2)?,
        plugin_version: row.get(3)?,
        package_digest: row.get(4)?,
        runtime_kind: row.get(5)?,
        permission: row.get(6)?,
        constraints_json: row.get(7)?,
        constraints_digest: row.get(8)?,
        purpose_text: row.get(9)?,
        status: row.get(10)?,
        requested_at: row.get(11)?,
        resolved_at: row.get(12)?,
        decision: row.get(13)?,
        grant_source: row.get(14)?,
        reason_code: row.get(15)?,
        expected_project_revision: row.get(16)?,
    })
}

fn decode_grant(row: &Row<'_>) -> rusqlite::Result<PluginPermissionGrant> {
    Ok(PluginPermissionGrant {
        grant_id: row.get(0)?,
        project_root: row.get(1)?,
        plugin_id: row.get(2)?,
        plugin_version: row.get(3)?,
        package_digest: row.get(4)?,
        runtime_kind: row.get(5)?,
        permission: row.get(6)?,
        constraints_json: row.get(7)?,
        constraints_digest: row.get(8)?,
        grant_source: row.get(9)?,
        policy_revision: row.get(10)?,
        created_at: row.get(11)?,
        expires_at: row.get(12)?,
        revoked_at: row.get(13)?,
        consumed_at: row.get(14)?,
        status: row.get(15)?,
        originating_request_id: row.get(16)?,
    })
}

fn decode_event(row: &Row<'_>) -> rusqlite::Result<PluginPermissionEvent> {
    Ok(PluginPermissionEvent {
        event_id: row.get(0)?,
        project_root: row.get(1)?,
        plugin_id: row.get(2)?,
        package_digest: row.get(3)?,
        request_id: row.get(4)?,
        grant_id: row.get(5)?,
        event_type: row.get(6)?,
        status: row.get(7)?,
        reason_code: row.get(8)?,
        details_json: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    use std::fmt::Write;
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, Store) {
        let directory = TempDir::new().unwrap();
        let store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        (directory, store)
    }

    fn request(id: &str, project: &str) -> PluginPermissionRequestDraft {
        let constraints = r#"{"maxBytes":1024,"paths":["data/**/*.csv"]}"#;
        let (canonical, digest) = canonical_constraints(constraints).unwrap();
        PluginPermissionRequestDraft {
            request_id: id.to_string(),
            project_root: project.to_string(),
            plugin_id: "org.example.plugin".to_string(),
            plugin_version: "1.2.3".to_string(),
            package_digest: "a".repeat(64),
            runtime_kind: "wasm".to_string(),
            permission: "project.fs.read".to_string(),
            constraints_json: canonical,
            constraints_digest: digest,
            purpose_text: Some("Read project CSV metadata".to_string()),
            expected_project_revision: 7,
        }
    }

    fn allow_once(id: &str, project: &str) -> PluginPermissionDecisionDraft {
        PluginPermissionDecisionDraft {
            request_id: id.to_string(),
            project_root: project.to_string(),
            expected_project_revision: 7,
            decision: PluginPermissionDecision::AllowOnce,
            reason_code: None,
            grant_id: Some(format!("grant.{id}")),
            policy_revision: Some(1),
            expires_at: Some((Utc::now() + Duration::minutes(4)).to_rfc3339()),
        }
    }

    #[test]
    fn request_is_normalized_canonical_and_project_scoped() {
        let (_directory, mut store) = store();
        let created = store
            .create_plugin_permission_request(&request("request.a", "D:\\project\\a\\"))
            .unwrap();
        assert_eq!(created.project_root, "D:/project/a");
        assert_eq!(created.status, "pending");
        assert_eq!(
            created.constraints_digest,
            sha256_hex(created.constraints_json.as_bytes())
        );
        assert!(
            store
                .get_plugin_permission_request("D:/project/b", "request.a")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .list_plugin_permission_events("D:/project/a", None)
                .unwrap()[0]
                .event_type,
            "request_created"
        );
    }

    #[test]
    fn invalid_request_leaves_no_partial_rows_or_events() {
        let (_directory, mut store) = store();
        let mut invalid = request("request.a", "D:/project/a");
        invalid.constraints_digest = "0".repeat(64);
        assert!(store.create_plugin_permission_request(&invalid).is_err());
        assert!(
            store
                .list_plugin_permission_requests("D:/project/a", None, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_plugin_permission_events("D:/project/a", None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn request_batch_is_all_or_nothing_on_second_insert_failure() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_second_plugin_permission_request
                 BEFORE INSERT ON plugin_permission_requests
                 WHEN NEW.request_id = 'request.b'
                 BEGIN SELECT RAISE(FAIL, 'injected second request failure'); END;",
            )
            .unwrap();
        let drafts = [
            request("request.a", "D:/project/a"),
            request("request.b", "D:/project/a"),
        ];
        assert!(store.create_plugin_permission_requests(&drafts).is_err());
        assert!(
            store
                .list_plugin_permission_requests("D:/project/a", None, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_plugin_permission_events("D:/project/a", None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn deny_is_atomic_idempotent_and_stale_safe() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        let deny = PluginPermissionDecisionDraft {
            request_id: "request.a".to_string(),
            project_root: "D:/project/a".to_string(),
            expected_project_revision: 7,
            decision: PluginPermissionDecision::Deny,
            reason_code: Some("user_denied".to_string()),
            grant_id: None,
            policy_revision: None,
            expires_at: None,
        };
        assert_eq!(
            store.resolve_plugin_permission_request(&deny).unwrap(),
            PluginPermissionMutationOutcome::Applied
        );
        assert_eq!(
            store.resolve_plugin_permission_request(&deny).unwrap(),
            PluginPermissionMutationOutcome::Unchanged
        );
        let mut changed = deny.clone();
        changed.decision = PluginPermissionDecision::AllowOnce;
        changed.grant_id = Some("grant.changed".to_string());
        changed.policy_revision = Some(1);
        changed.expires_at = Some((Utc::now() + Duration::minutes(4)).to_rfc3339());
        assert_eq!(
            store.resolve_plugin_permission_request(&changed).unwrap(),
            PluginPermissionMutationOutcome::Stale
        );
        assert!(
            store
                .list_plugin_permission_grants("D:/project/a", None, None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn allow_once_grant_consumes_and_survives_reopen() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        let decision = allow_once("request.a", "D:/project/a");
        assert_eq!(
            store.resolve_plugin_permission_request(&decision).unwrap(),
            PluginPermissionMutationOutcome::Applied
        );
        let grant = store
            .list_plugin_permission_grants("D:/project/a", None, Some("active"))
            .unwrap()
            .remove(0);
        assert_eq!(grant.grant_source, "allow_once");
        let mut changed_retry = decision.clone();
        changed_retry.grant_id = Some("grant.changed".to_string());
        assert_eq!(
            store
                .resolve_plugin_permission_request(&changed_retry)
                .unwrap(),
            PluginPermissionMutationOutcome::Stale
        );
        assert_eq!(
            store
                .consume_plugin_permission_grant("D:/project/a", &grant.grant_id)
                .unwrap(),
            PluginPermissionMutationOutcome::Applied
        );
        drop(store);
        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened
                .list_plugin_permission_grants("D:/project/a", None, Some("consumed"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn grant_insert_failure_rolls_back_request_and_event() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_plugin_grant
                 BEFORE INSERT ON plugin_permission_grants
                 BEGIN SELECT RAISE(ABORT, 'injected grant failure'); END;",
            )
            .unwrap();
        assert!(
            store
                .resolve_plugin_permission_request(&allow_once("request.a", "D:/project/a"))
                .is_err()
        );
        assert_eq!(
            store
                .get_plugin_permission_request("D:/project/a", "request.a")
                .unwrap()
                .unwrap()
                .status,
            "pending"
        );
        assert_eq!(
            store
                .list_plugin_permission_events("D:/project/a", None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn recovery_cancels_only_exact_project_pending_requests() {
        let (_directory, mut store) = store();
        for (id, project) in [("request.a", "D:/project/a"), ("request.b", "D:/project/b")] {
            store
                .create_plugin_permission_request(&request(id, project))
                .unwrap();
        }
        assert_eq!(
            store
                .recover_pending_plugin_permission_requests("D:/project/a", "broker_restart")
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .get_plugin_permission_request("D:/project/a", "request.a")
                .unwrap()
                .unwrap()
                .status,
            "cancelled"
        );
        assert_eq!(
            store
                .get_plugin_permission_request("D:/project/b", "request.b")
                .unwrap()
                .unwrap()
                .status,
            "pending"
        );
    }

    #[test]
    fn restart_recovery_revokes_only_exact_project_allow_once_grants() {
        let (_directory, mut store) = store();
        for (request_id, project) in [
            ("request.once.a", "D:/project/a"),
            ("request.project.a", "D:/project/a"),
            ("request.once.b", "D:/project/b"),
        ] {
            store
                .create_plugin_permission_request(&request(request_id, project))
                .unwrap();
        }
        store
            .resolve_plugin_permission_request(&allow_once("request.once.a", "D:/project/a"))
            .unwrap();
        let mut project_decision = allow_once("request.project.a", "D:/project/a");
        project_decision.decision = PluginPermissionDecision::AllowProject;
        project_decision.grant_id = Some("grant.request.project.a".to_string());
        project_decision.expires_at = Some((Utc::now() + Duration::days(20)).to_rfc3339());
        store
            .resolve_plugin_permission_request(&project_decision)
            .unwrap();
        store
            .resolve_plugin_permission_request(&allow_once("request.once.b", "D:/project/b"))
            .unwrap();

        assert_eq!(
            store
                .recover_transient_plugin_permission_grants("D:/project/a", "broker_restart")
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .recover_transient_plugin_permission_grants("D:/project/a", "broker_restart")
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .list_plugin_permission_grants("D:/project/a", None, Some("active"))
                .unwrap()
                .iter()
                .map(|grant| grant.grant_source.as_str())
                .collect::<Vec<_>>(),
            vec!["project"]
        );
        assert_eq!(
            store
                .list_plugin_permission_grants("D:/project/b", None, Some("active"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn call_audit_and_allow_once_consumption_commit_atomically() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        store
            .resolve_plugin_permission_request(&allow_once("request.a", "D:/project/a"))
            .unwrap();
        let event =
            |event_type: &str, status: &str, details_json: &str| PluginPermissionCallEventDraft {
                project_root: "D:/project/a".to_string(),
                plugin_id: "org.example.plugin".to_string(),
                package_digest: "a".repeat(64),
                grant_id: Some("grant.request.a".to_string()),
                event_type: event_type.to_string(),
                status: status.to_string(),
                reason_code: None,
                details_json: details_json.to_string(),
            };
        let admitted_event_id = store
            .record_plugin_permission_call_event(
                &event(
                    "call_admitted",
                    "completed",
                    r#"{"operation":"project.fs.read"}"#,
                ),
                false,
            )
            .unwrap();
        let completed_event_id = store
            .record_plugin_permission_call_event(
                &event(
                    "call_completed",
                    "completed",
                    r#"{"durationMs":2,"operation":"project.fs.read","sizeBytes":5}"#,
                ),
                true,
            )
            .unwrap();
        assert!(admitted_event_id.starts_with("event."));
        assert!(completed_event_id.starts_with("event."));
        assert_ne!(admitted_event_id, completed_event_id);
        assert_eq!(
            store
                .list_plugin_permission_grants("D:/project/a", None, Some("consumed"))
                .unwrap()
                .len(),
            1
        );
        let events = store
            .list_plugin_permission_events("D:/project/a", Some(20))
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "call_admitted")
        );
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "call_completed")
        );
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "grant_consumed")
        );
        let encoded = serde_json::to_string(&events).unwrap();
        assert!(!encoded.contains("handle."));
    }

    #[test]
    fn call_completion_failure_rolls_back_consumption_and_rejects_sensitive_details() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        store
            .resolve_plugin_permission_request(&allow_once("request.a", "D:/project/a"))
            .unwrap();
        let mut event = PluginPermissionCallEventDraft {
            project_root: "D:/project/a".to_string(),
            plugin_id: "org.example.plugin".to_string(),
            package_digest: "a".repeat(64),
            grant_id: Some("grant.request.a".to_string()),
            event_type: "call_completed".to_string(),
            status: "completed".to_string(),
            reason_code: None,
            details_json: r#"{"operation":"project.fs.read","sizeBytes":5}"#.to_string(),
        };
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_plugin_call_completion
                 BEFORE INSERT ON plugin_permission_events
                 WHEN NEW.event_type = 'call_completed'
                 BEGIN SELECT RAISE(FAIL, 'injected completion failure'); END;",
            )
            .unwrap();
        assert!(
            store
                .record_plugin_permission_call_event(&event, true)
                .is_err()
        );
        assert_eq!(
            store
                .list_plugin_permission_grants("D:/project/a", None, Some("active"))
                .unwrap()
                .len(),
            1
        );
        event.details_json = r#"{"handleId":"handle.secret"}"#.to_string();
        assert!(
            store
                .record_plugin_permission_call_event(&event, false)
                .is_err()
        );
    }

    #[test]
    fn revoke_is_project_scoped_and_idempotent() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        store
            .resolve_plugin_permission_request(&allow_once("request.a", "D:/project/a"))
            .unwrap();
        assert_eq!(
            store
                .revoke_plugin_permission_grant("D:/project/b", "grant.request.a", "user_revoked")
                .unwrap(),
            PluginPermissionMutationOutcome::NotFound
        );
        assert_eq!(
            store
                .revoke_plugin_permission_grant("D:/project/a", "grant.request.a", "user_revoked")
                .unwrap(),
            PluginPermissionMutationOutcome::Applied
        );
        assert_eq!(
            store
                .revoke_plugin_permission_grant("D:/project/a", "grant.request.a", "user_revoked")
                .unwrap(),
            PluginPermissionMutationOutcome::Unchanged
        );
    }

    #[test]
    fn expiry_and_decision_bounds_fail_closed() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        let mut too_long = allow_once("request.a", "D:/project/a");
        too_long.expires_at = Some((Utc::now() + Duration::minutes(6)).to_rfc3339());
        assert!(store.resolve_plugin_permission_request(&too_long).is_err());
        assert_eq!(
            store
                .get_plugin_permission_request("D:/project/a", "request.a")
                .unwrap()
                .unwrap()
                .status,
            "pending"
        );
    }

    #[test]
    fn grant_expiry_is_deterministic_project_scoped_and_idempotent() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-20T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let decision = PluginPermissionDecisionDraft {
            request_id: "request.a".to_string(),
            project_root: "D:/project/a".to_string(),
            expected_project_revision: 7,
            decision: PluginPermissionDecision::AllowProject,
            reason_code: Some("user_allowed".to_string()),
            grant_id: Some("grant.a".to_string()),
            policy_revision: Some(4),
            expires_at: Some((now + Duration::days(29)).to_rfc3339()),
        };
        assert_eq!(
            store
                .resolve_plugin_permission_request_at(&decision, now)
                .unwrap(),
            PluginPermissionMutationOutcome::Applied
        );
        assert_eq!(
            store
                .expire_plugin_permission_grants_at("D:/project/b", now + Duration::days(30))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .expire_plugin_permission_grants_at("D:/project/a", now + Duration::days(28))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .expire_plugin_permission_grants_at("D:/project/a", now + Duration::days(30))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .expire_plugin_permission_grants_at("D:/project/a", now + Duration::days(31))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .list_plugin_permission_grants("D:/project/a", None, Some("expired"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn constraint_shapes_canonical_encoding_and_untrusted_text_fail_closed() {
        let (_directory, mut store) = store();
        let mut noncanonical = request("request.space", "D:/project/a");
        noncanonical.constraints_json =
            "{ \"maxBytes\": 1024, \"paths\": [\"data/**/*.csv\"] }".to_string();
        noncanonical.constraints_digest =
            sha256_hex(r#"{"maxBytes":1024,"paths":["data/**/*.csv"]}"#.as_bytes());
        assert!(
            store
                .create_plugin_permission_request(&noncanonical)
                .is_err()
        );

        let mut escape = request("request.escape", "D:/project/a");
        set_constraints(
            &mut escape,
            serde_json::json!({"maxBytes": 1024, "paths": ["../secret"]}),
        );
        assert!(store.create_plugin_permission_request(&escape).is_err());

        let mut unknown = request("request.unknown", "D:/project/a");
        set_constraints(
            &mut unknown,
            serde_json::json!({
                "maxBytes": 1024,
                "paths": ["data/*.csv"],
                "write": true
            }),
        );
        assert!(store.create_plugin_permission_request(&unknown).is_err());

        let mut bidi = request("request.bidi", "D:/project/a");
        bidi.purpose_text = Some("trusted\u{202e}deny".to_string());
        assert!(store.create_plugin_permission_request(&bidi).is_err());

        let mut network = request("request.network", "D:/project/a");
        network.permission = "network.fetch".to_string();
        set_constraints(
            &mut network,
            serde_json::json!({
                "hosts": ["bioconductor.org"],
                "maxResponseBytes": 4096,
                "methods": ["GET"],
                "schemes": ["https"]
            }),
        );
        assert!(store.create_plugin_permission_request(&network).is_ok());
    }

    #[test]
    fn cancellation_rejects_stale_revision_and_recovers_exactly_once() {
        let (_directory, mut store) = store();
        store
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        assert_eq!(
            store
                .cancel_plugin_permission_request(
                    "D:/project/a",
                    "request.a",
                    8,
                    "project_switched"
                )
                .unwrap(),
            PluginPermissionMutationOutcome::Stale
        );
        assert_eq!(
            store
                .cancel_plugin_permission_request(
                    "D:/project/a",
                    "request.a",
                    7,
                    "project_switched"
                )
                .unwrap(),
            PluginPermissionMutationOutcome::Applied
        );
        assert_eq!(
            store
                .cancel_plugin_permission_request(
                    "D:/project/a",
                    "request.a",
                    7,
                    "project_switched"
                )
                .unwrap(),
            PluginPermissionMutationOutcome::Unchanged
        );
    }

    #[test]
    fn concurrent_identical_decisions_apply_once_and_converge() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut initial = Store::open(&database).unwrap();
        initial
            .create_plugin_permission_request(&request("request.a", "D:/project/a"))
            .unwrap();
        drop(initial);

        let decision = allow_once("request.a", "D:/project/a");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let database = database.clone();
            let decision = decision.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                let mut store = Store::open(database).unwrap();
                barrier.wait();
                store.resolve_plugin_permission_request(&decision)
            }));
        }
        let outcomes = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginPermissionMutationOutcome::Applied)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == PluginPermissionMutationOutcome::Unchanged)
                .count(),
            1
        );
        let reopened = Store::open(database).unwrap();
        assert_eq!(
            reopened
                .list_plugin_permission_grants("D:/project/a", None, Some("active"))
                .unwrap()
                .len(),
            1
        );
    }

    fn set_constraints(request: &mut PluginPermissionRequestDraft, constraints: serde_json::Value) {
        request.constraints_json = serde_json::to_string(&constraints).unwrap();
        request.constraints_digest = sha256_hex(request.constraints_json.as_bytes());
    }
}
