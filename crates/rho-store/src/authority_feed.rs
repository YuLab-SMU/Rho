use rho_protocol::{
    AUTHORITY_CONTRACT_VERSION, AgentTurnRefV1, ApprovalReceiptV1, ArtifactReceiptV1,
    AuthorityDigest, AuthorityKindV1, AuthorityReceiptBatchV1, AuthorityReceiptV1, AuthorityRefV1,
    AuthorityStatusV1, EnvironmentReceiptV1, MAX_RECEIPT_BATCH_ITEMS, ProjectId, ProjectRevision,
    RevisionRefV1, RunReceiptV1, StateRevision,
};
use rusqlite::params;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Store, StoreConnection, StoreError, StoreExecutor, StoreExecutorError};

const FEED_ID: &str = "rho-store-authority-v1";

#[derive(Clone, Debug)]
pub struct AuthorityFeed {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn authority_feed(&self) -> AuthorityFeed {
        AuthorityFeed {
            executor: self.clone(),
        }
    }
}

impl AuthorityFeed {
    pub async fn receipt_batch(
        &self,
        project_root: String,
        project_id: ProjectId,
        after_cursor: u64,
        limit: usize,
    ) -> Result<AuthorityReceiptBatchV1, StoreExecutorError> {
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).authority_receipt_batch(
                    &project_root,
                    &project_id,
                    after_cursor,
                    limit,
                )
            })
            .await
    }
}

impl<C: StoreConnection> Store<C> {
    pub fn authority_receipt_batch(
        &self,
        project_root: &str,
        project_id: &ProjectId,
        after_cursor: u64,
        limit: usize,
    ) -> Result<AuthorityReceiptBatchV1, StoreError> {
        if project_root.trim().is_empty() || project_root.trim() != project_root {
            return Err(StoreError::Validation(
                "authority feed requires a normalized project root".to_string(),
            ));
        }
        if limit == 0 || limit > MAX_RECEIPT_BATCH_ITEMS {
            return Err(StoreError::Validation(format!(
                "authority feed limit must be between 1 and {MAX_RECEIPT_BATCH_ITEMS}"
            )));
        }
        let after = i64::try_from(after_cursor).map_err(|_| {
            StoreError::Validation("authority feed cursor exceeds INT64".to_string())
        })?;
        let mut statement = self.connection.prepare(
            "SELECT seq, authority_kind, authority_id
             FROM authority_receipt_log
             WHERE project_root = ?1 AND seq > ?2
             ORDER BY seq
             LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![project_root, after, limit as i64 + 1], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = rows.len() > limit;
        let selected = rows.into_iter().take(limit).collect::<Vec<_>>();
        let next_cursor = selected
            .last()
            .map(|row| u64::try_from(row.0))
            .transpose()
            .map_err(|_| StoreError::Validation("negative authority feed cursor".to_string()))?
            .unwrap_or(after_cursor);
        let mut receipts = Vec::new();
        for (_, kind, authority_id) in &selected {
            if let Some(receipt) = self.receipt_for(project_root, project_id, kind, authority_id)? {
                receipts.push(receipt);
            }
        }
        let batch = AuthorityReceiptBatchV1 {
            contract_version: AUTHORITY_CONTRACT_VERSION,
            feed_id: FEED_ID.to_string(),
            after_cursor,
            next_cursor,
            has_more,
            receipts,
        };
        batch.validate().map_err(|error| {
            StoreError::Validation(format!("authority feed produced an invalid batch: {error}"))
        })?;
        Ok(batch)
    }

    fn receipt_for(
        &self,
        project_root: &str,
        project_id: &ProjectId,
        kind: &str,
        authority_id: &str,
    ) -> Result<Option<AuthorityReceiptV1>, StoreError> {
        match kind {
            "run" => self.run_receipt(project_root, project_id, authority_id),
            "artifact" => self.artifact_receipt(project_root, project_id, authority_id),
            "approval" => self.approval_receipt(project_root, project_id, authority_id),
            "environment_snapshot" => {
                self.environment_receipt(project_root, project_id, authority_id)
            }
            "agent_turn" => self.agent_turn_receipt(project_root, project_id, authority_id),
            _ => Ok(None),
        }
    }

    fn run_receipt(
        &self,
        project_root: &str,
        project_id: &ProjectId,
        run_id: &str,
    ) -> Result<Option<AuthorityReceiptV1>, StoreError> {
        let Some(run) = self.get_run_detail(project_root, run_id)? else {
            return Ok(None);
        };
        let reference = authority_ref(project_id, AuthorityKindV1::Run, &run.run_id)?;
        let revision_before = revision_ref(
            project_id,
            run.project_revision_before,
            run.state_revision_before,
        )?;
        let revision_after = revision_ref(
            project_id,
            run.project_revision_after,
            run.state_revision_after,
        )?;
        let environment_id = run
            .environment_snapshot_id_after
            .as_ref()
            .or(run.environment_snapshot_id.as_ref());
        let receipt = RunReceiptV1 {
            reference,
            status: run_status(&run.status),
            revision_before,
            revision_after,
            environment_ref: environment_id
                .map(|id| authority_ref(project_id, AuthorityKindV1::EnvironmentSnapshot, id))
                .transpose()?,
            source_anchor_ref: None,
            captured_at: run.finished_at.unwrap_or(run.started_at),
        };
        Ok(Some(AuthorityReceiptV1::Run(receipt)))
    }

    fn artifact_receipt(
        &self,
        project_root: &str,
        project_id: &ProjectId,
        artifact_id: &str,
    ) -> Result<Option<AuthorityReceiptV1>, StoreError> {
        let Some(artifact) = self.get_artifact_record(project_root, artifact_id)? else {
            return Ok(None);
        };
        let metadata: Value = serde_json::from_str(&artifact.metadata_json)?;
        let Some(digest) = metadata_digest(&metadata) else {
            return Ok(None);
        };
        let Some(byte_size) = metadata.get("byte_size").and_then(Value::as_u64) else {
            return Ok(None);
        };
        let revision = revision_ref(
            project_id,
            artifact.project_revision,
            artifact.state_revision,
        )?
        .unwrap_or(RevisionRefV1 {
            reference: authority_ref(project_id, AuthorityKindV1::Revision, "project_revision:0")?,
            state_revision: None,
            project_revision: ProjectRevision(0),
        });
        Ok(Some(AuthorityReceiptV1::Artifact(ArtifactReceiptV1 {
            reference: authority_ref(project_id, AuthorityKindV1::Artifact, &artifact.artifact_id)?,
            digest,
            byte_size,
            media_type: artifact.media_type,
            producing_run_ref: artifact
                .run_id
                .map(|id| authority_ref(project_id, AuthorityKindV1::Run, &id))
                .transpose()?,
            revision,
            captured_at: artifact.created_at,
        })))
    }

    fn approval_receipt(
        &self,
        project_root: &str,
        project_id: &ProjectId,
        request_id: &str,
    ) -> Result<Option<AuthorityReceiptV1>, StoreError> {
        let Some(approval) = self.get_approval_request(project_root, request_id)? else {
            return Ok(None);
        };
        let effect_digest = AuthorityDigest::new(format!(
            "sha256:{:x}",
            Sha256::digest(approval.arguments_json.as_bytes())
        ))
        .map_err(|error| StoreError::Validation(error.to_string()))?;
        Ok(Some(AuthorityReceiptV1::Approval(ApprovalReceiptV1 {
            reference: authority_ref(project_id, AuthorityKindV1::Approval, &approval.request_id)?,
            status: approval_status(&approval.status, approval.decision.as_deref()),
            agent_turn_ref: Some(authority_ref(
                project_id,
                AuthorityKindV1::AgentTurn,
                &approval.turn_id,
            )?),
            effect_digest,
            captured_at: approval.responded_at.unwrap_or(approval.requested_at),
        })))
    }

    fn environment_receipt(
        &self,
        project_root: &str,
        project_id: &ProjectId,
        snapshot_id: &str,
    ) -> Result<Option<AuthorityReceiptV1>, StoreError> {
        let Some(snapshot) = self.get_environment_snapshot(snapshot_id)? else {
            return Ok(None);
        };
        if snapshot.project_root != project_root {
            return Ok(None);
        }
        let digest = AuthorityDigest::new(format!(
            "sha256:{:x}",
            Sha256::digest(snapshot.canonical_json.as_bytes())
        ))
        .map_err(|error| StoreError::Validation(error.to_string()))?;
        Ok(Some(AuthorityReceiptV1::Environment(
            EnvironmentReceiptV1 {
                reference: authority_ref(
                    project_id,
                    AuthorityKindV1::EnvironmentSnapshot,
                    &snapshot.snapshot_id,
                )?,
                digest,
                captured_at: snapshot.last_captured_at,
            },
        )))
    }

    fn agent_turn_receipt(
        &self,
        project_root: &str,
        project_id: &ProjectId,
        turn_id: &str,
    ) -> Result<Option<AuthorityReceiptV1>, StoreError> {
        let Some(detail) = self.get_agent_turn_detail(project_root, turn_id)? else {
            return Ok(None);
        };
        Ok(Some(AuthorityReceiptV1::AgentTurn(AgentTurnRefV1 {
            reference: authority_ref(project_id, AuthorityKindV1::AgentTurn, &detail.turn.turn_id)?,
            status: run_status(&detail.turn.status),
            captured_at: detail.turn.finished_at.unwrap_or(detail.turn.started_at),
        })))
    }
}

fn authority_ref(
    project_id: &ProjectId,
    kind: AuthorityKindV1,
    id: &str,
) -> Result<AuthorityRefV1, StoreError> {
    AuthorityRefV1::new(project_id.clone(), kind, id)
        .map_err(|error| StoreError::Validation(error.to_string()))
}

fn revision_ref(
    project_id: &ProjectId,
    project_revision: Option<i64>,
    state_revision: Option<i64>,
) -> Result<Option<RevisionRefV1>, StoreError> {
    let Some(project_revision) = project_revision.and_then(|value| u64::try_from(value).ok())
    else {
        return Ok(None);
    };
    Ok(Some(RevisionRefV1 {
        reference: authority_ref(
            project_id,
            AuthorityKindV1::Revision,
            &format!("project_revision:{project_revision}"),
        )?,
        state_revision: state_revision
            .and_then(|value| u64::try_from(value).ok())
            .map(StateRevision),
        project_revision: ProjectRevision(project_revision),
    }))
}

fn metadata_digest(metadata: &Value) -> Option<AuthorityDigest> {
    ["digest", "sha256", "content_sha256"]
        .into_iter()
        .filter_map(|key| metadata.get(key).and_then(Value::as_str))
        .find_map(|value| {
            let value = if value.starts_with("sha256:") {
                value.to_string()
            } else {
                format!("sha256:{value}")
            };
            AuthorityDigest::new(value).ok()
        })
}

fn run_status(status: &str) -> AuthorityStatusV1 {
    match status {
        "pending" | "queued" => AuthorityStatusV1::Pending,
        "running" | "waiting" => AuthorityStatusV1::Running,
        "completed" | "succeeded" => AuthorityStatusV1::Succeeded,
        "failed" => AuthorityStatusV1::Failed,
        "cancelled" | "canceled" | "interrupted" => AuthorityStatusV1::Cancelled,
        _ => AuthorityStatusV1::Uncertain,
    }
}

fn approval_status(status: &str, decision: Option<&str>) -> AuthorityStatusV1 {
    match decision {
        Some("approve" | "approved" | "allow") => AuthorityStatusV1::Approved,
        Some("reject" | "rejected" | "deny") => AuthorityStatusV1::Rejected,
        _ => match status {
            "cancelled" | "canceled" | "interrupted" => AuthorityStatusV1::Cancelled,
            "completed" | "committed" => AuthorityStatusV1::Committed,
            _ => AuthorityStatusV1::Pending,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EnvironmentSnapshotDraft, RunDraft, RunFinish};

    #[test]
    fn authority_feed_tracks_committed_projection_changes_with_a_durable_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let root = "/projects/a";
        store
            .create_run(&RunDraft {
                run_id: "run:1".to_string(),
                parent_run_id: None,
                project_root: root.to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "scientific".to_string(),
                code: "1 + 1".to_string(),
                arguments_json: "{}".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("expression".to_string()),
                document_version: Some(1),
                workspace_id: "workspace:1".to_string(),
                state_revision_before: 1,
                project_revision_before: 2,
                environment_snapshot_id: Some("environment:1".to_string()),
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: "run:1".to_string(),
                status: "completed".to_string(),
                terminal_reason: None,
                workspace_id: Some("workspace:1".to_string()),
                state_revision_after: Some(2),
                project_revision_after: Some(2),
                stdout: Some("[1] 2".to_string()),
                value_text: Some("2".to_string()),
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: Some("environment:1".to_string()),
            })
            .unwrap();
        store
            .record_environment_snapshot(&EnvironmentSnapshotDraft {
                snapshot_id: "environment:1".to_string(),
                project_root: root.to_string(),
                canonical_json: "{\"R\":\"4.5.2\"}".to_string(),
            })
            .unwrap();

        let project_id = ProjectId::new("project:a").unwrap();
        let batch = store
            .authority_receipt_batch(root, &project_id, 0, 10)
            .unwrap();
        assert_eq!(batch.next_cursor, 3);
        assert!(!batch.has_more);
        assert_eq!(batch.receipts.len(), 3);
        assert!(matches!(
            &batch.receipts[0],
            AuthorityReceiptV1::Run(value) if value.status == AuthorityStatusV1::Succeeded
        ));
        assert!(matches!(
            &batch.receipts[2],
            AuthorityReceiptV1::Environment(_)
        ));

        let empty = store
            .authority_receipt_batch(root, &project_id, batch.next_cursor, 10)
            .unwrap();
        assert!(empty.receipts.is_empty());
        assert_eq!(empty.next_cursor, batch.next_cursor);
        assert!(
            store
                .authority_receipt_batch(
                    "/projects/b",
                    &ProjectId::new("project:b").unwrap(),
                    0,
                    10,
                )
                .unwrap()
                .receipts
                .is_empty()
        );
    }
}
