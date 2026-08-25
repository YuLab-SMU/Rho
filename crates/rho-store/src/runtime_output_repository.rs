//! Asynchronous Runtime Output projections and bounded maintenance.

use crate::{
    ProjectRetentionSummary, RuntimeExecution, RuntimeExecutionDeleteResult, RuntimeExecutionDraft,
    RuntimeExecutionFinish, RuntimeExecutionMutationOutcome, RuntimeOutputAppendResult,
    RuntimeOutputDraft, RuntimeOutputPage, RuntimeOutputPolicy, RuntimeOutputPolicyUpdate,
    RuntimeOutputPruneResult, RuntimeOutputSearchResult, Store, StoreExecutor, StoreExecutorError,
    query::required_project_root,
};

#[derive(Clone, Debug)]
pub struct RuntimeOutputPolicySnapshot {
    pub policy: RuntimeOutputPolicy,
    pub retention: ProjectRetentionSummary,
}

#[derive(Clone, Debug)]
pub struct RuntimeOutputRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn runtime_output_repository(&self) -> RuntimeOutputRepository {
        RuntimeOutputRepository {
            executor: self.clone(),
        }
    }
}

impl RuntimeOutputRepository {
    pub async fn create_execution(
        &self,
        mut draft: RuntimeExecutionDraft,
    ) -> Result<RuntimeExecution, StoreExecutorError> {
        draft.project_root = required_project_root(&draft.project_root)?;
        self.executor
            .call(move |connection| Store::borrowed(connection).create_runtime_execution(&draft))
            .await
    }

    pub async fn mark_running(
        &self,
        project_root: String,
        execution_id: String,
    ) -> Result<RuntimeExecutionMutationOutcome, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .mark_runtime_execution_running(&project_root, &execution_id)
            })
            .await
    }

    pub async fn link_run(
        &self,
        project_root: String,
        execution_id: String,
        run_id: String,
    ) -> Result<RuntimeExecutionMutationOutcome, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).link_runtime_execution_run(
                    &project_root,
                    &execution_id,
                    &run_id,
                )
            })
            .await
    }

    pub async fn append(
        &self,
        project_root: String,
        execution_id: String,
        drafts: Vec<RuntimeOutputDraft>,
    ) -> Result<RuntimeOutputAppendResult, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let mut store = Store::borrowed(connection);
                let capture_limit = store
                    .get_runtime_output_policy(&project_root)?
                    .max_runtime_output_bytes_per_execution;
                store.append_runtime_output(&project_root, &execution_id, &drafts, capture_limit)
            })
            .await
    }

    pub async fn finish(
        &self,
        project_root: String,
        execution_id: String,
        finish: RuntimeExecutionFinish,
    ) -> Result<RuntimeExecutionMutationOutcome, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).finish_runtime_execution(
                    &project_root,
                    &execution_id,
                    &finish,
                )
            })
            .await
    }

    pub async fn reconcile_interrupted(
        &self,
        project_root: String,
    ) -> Result<i64, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).reconcile_interrupted_runtime_executions(&project_root)
            })
            .await
    }

    pub async fn get_execution(
        &self,
        project_root: String,
        execution_id: String,
    ) -> Result<Option<RuntimeExecution>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).get_runtime_execution(&project_root, &execution_id)
            })
            .await
    }

    pub async fn list_executions(
        &self,
        project_root: String,
        limit: Option<usize>,
        before: Option<(String, String)>,
    ) -> Result<Vec<RuntimeExecution>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).list_runtime_executions_before(
                    &project_root,
                    limit,
                    before.as_ref().map(|(started_at, execution_id)| {
                        (started_at.as_str(), execution_id.as_str())
                    }),
                )
            })
            .await
    }

    pub async fn search(
        &self,
        project_root: String,
        query: String,
        console_instance_id: Option<String>,
        started_after: Option<String>,
        limit: usize,
    ) -> Result<RuntimeOutputSearchResult, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).search_runtime_output(
                    &project_root,
                    &query,
                    console_instance_id.as_deref(),
                    started_after.as_deref(),
                    limit,
                )
            })
            .await
    }

    pub async fn policy(
        &self,
        project_root: String,
    ) -> Result<RuntimeOutputPolicySnapshot, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let store = Store::borrowed(connection);
                Ok(RuntimeOutputPolicySnapshot {
                    policy: store.get_runtime_output_policy(&project_root)?,
                    retention: store.project_retention_summary(&project_root, None)?,
                })
            })
            .await
    }

    pub async fn update_policy(
        &self,
        project_root: String,
        update: RuntimeOutputPolicyUpdate,
    ) -> Result<RuntimeOutputPolicySnapshot, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let mut store = Store::borrowed(connection);
                let policy = store.update_runtime_output_policy(&project_root, &update)?;
                let retention = store.project_retention_summary(&project_root, None)?;
                Ok(RuntimeOutputPolicySnapshot { policy, retention })
            })
            .await
    }

    pub async fn page(
        &self,
        project_root: String,
        execution_id: String,
        after_sequence: i64,
        before_sequence: Option<i64>,
        page_size: usize,
        byte_limit: usize,
    ) -> Result<RuntimeOutputPage, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let store = Store::borrowed(connection);
                if let Some(before_sequence) = before_sequence {
                    store.runtime_output_page_before(
                        &project_root,
                        &execution_id,
                        before_sequence,
                        page_size,
                        byte_limit,
                    )
                } else {
                    store.runtime_output_page(
                        &project_root,
                        &execution_id,
                        after_sequence,
                        page_size,
                        byte_limit,
                    )
                }
            })
            .await
    }

    pub async fn prune(
        &self,
        project_root: String,
        execution_id: String,
    ) -> Result<RuntimeOutputPruneResult, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .prune_runtime_output_payloads(&project_root, &execution_id)
            })
            .await
    }

    pub async fn delete(
        &self,
        project_root: String,
        execution_id: String,
    ) -> Result<RuntimeExecutionDeleteResult, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .delete_runtime_execution_record(&project_root, &execution_id)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::{RuntimeExecutionDraft, RuntimeOutputDraft, RuntimeOutputPayload};

    fn execution(project_root: &str, execution_id: &str) -> RuntimeExecutionDraft {
        RuntimeExecutionDraft {
            execution_id: execution_id.to_string(),
            project_root: project_root.to_string(),
            run_id: None,
            runtime_provider_id: "rho.ark-r".to_string(),
            runtime_instance_id: format!("runtime-{execution_id}"),
            runtime_activation_generation: 1,
            console_instance_id: format!("console-{execution_id}"),
            submitted_code: "message('repository output')".to_string(),
            workspace_id: Some(format!("workspace-{execution_id}")),
            source_path: None,
            execution_mode: Some("console".to_string()),
            document_version: None,
        }
    }

    #[tokio::test]
    async fn repository_preserves_queries_policy_maintenance_and_project_isolation() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        drop(Store::open(&database).unwrap());

        let repository = StoreExecutor::open(&database)
            .await
            .unwrap()
            .runtime_output_repository();
        repository
            .create_execution(execution("/projects/a", "execution-a"))
            .await
            .unwrap();
        repository
            .mark_running("/projects/a".to_string(), "execution-a".to_string())
            .await
            .unwrap();
        repository
            .append(
                "/projects/a".to_string(),
                "execution-a".to_string(),
                vec![RuntimeOutputDraft {
                    producer_sequence: 1,
                    projection_slot: 0,
                    source_kind: "kernel_event".to_string(),
                    presentation_kind: "message".to_string(),
                    media_type: Some("text/plain".to_string()),
                    payload: RuntimeOutputPayload::InlineText {
                        text: "repository output".to_string(),
                    },
                }],
            )
            .await
            .unwrap();
        repository
            .create_execution(execution("/projects/b", "execution-b"))
            .await
            .unwrap();
        assert!(
            repository
                .get_execution(" ".to_string(), "execution-a".to_string())
                .await
                .is_err()
        );
        assert!(
            repository
                .get_execution("/projects/b".to_string(), "execution-a".to_string())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            repository
                .list_executions("/projects/a/".to_string(), Some(10), None)
                .await
                .unwrap()
                .len(),
            1
        );
        let page = repository
            .page(
                "/projects/a".to_string(),
                "execution-a".to_string(),
                0,
                None,
                20,
                64 * 1024,
            )
            .await
            .unwrap();
        assert_eq!(page.chunks.len(), 1);
        assert_eq!(
            repository
                .search(
                    "/projects/a".to_string(),
                    "repository output".to_string(),
                    None,
                    None,
                    10,
                )
                .await
                .unwrap()
                .matched_execution_count,
            1
        );
        let policy = repository.policy("/projects/a".to_string()).await.unwrap();
        let updated = repository
            .update_policy(
                "/projects/a".to_string(),
                RuntimeOutputPolicyUpdate {
                    expected_revision: policy.policy.revision,
                    max_runtime_output_bytes_per_execution: Some(1024 * 1024),
                    runtime_output_project_warning_bytes: Some(2 * 1024 * 1024),
                    max_runtime_execution_rows: Some(100),
                    auto_prune_enabled: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.policy.revision, policy.policy.revision + 1);

        assert_eq!(
            repository
                .reconcile_interrupted("/projects/a".to_string())
                .await
                .unwrap(),
            1
        );
        let reconciled = repository
            .get_execution("/projects/a".to_string(), "execution-a".to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reconciled.status, "failed");
        assert!(matches!(
            repository
                .prune("/projects/a".to_string(), "execution-a".to_string())
                .await
                .unwrap()
                .outcome,
            crate::RuntimeExecutionMutationOutcome::Applied
                | crate::RuntimeExecutionMutationOutcome::Unchanged
        ));
        assert!(matches!(
            repository
                .delete("/projects/a".to_string(), "execution-a".to_string())
                .await
                .unwrap()
                .outcome,
            crate::RuntimeExecutionMutationOutcome::Applied
        ));
        assert!(
            repository
                .get_execution("/projects/b".to_string(), "execution-b".to_string())
                .await
                .unwrap()
                .is_some()
        );
        repository
            .mark_running("/projects/b".to_string(), "execution-b".to_string())
            .await
            .unwrap();
        assert!(matches!(
            repository
                .finish(
                    "/projects/b".to_string(),
                    "execution-b".to_string(),
                    RuntimeExecutionFinish {
                        status: "completed".to_string(),
                        terminal_reason: None,
                        output_state: "complete".to_string(),
                    },
                )
                .await
                .unwrap(),
            RuntimeExecutionMutationOutcome::Applied
        ));
    }
}
