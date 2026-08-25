//! Asynchronous durable Environment operation request repository.

use crate::{
    EnvironmentOperationDecisionRecord, EnvironmentOperationRequestSummary, Store, StoreExecutor,
    StoreExecutorError, query::required_project_root,
};

#[derive(Clone, Debug)]
pub struct EnvironmentRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn environment_repository(&self) -> EnvironmentRepository {
        EnvironmentRepository {
            executor: self.clone(),
        }
    }
}

impl EnvironmentRepository {
    pub async fn list_requests(
        &self,
        project_root: String,
        limit: Option<usize>,
        status: Option<String>,
    ) -> Result<Vec<EnvironmentOperationRequestSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).list_environment_operation_requests(
                    &project_root,
                    limit,
                    status.as_deref(),
                )
            })
            .await
    }

    pub async fn get_request(
        &self,
        project_root: String,
        request_id: String,
    ) -> Result<Option<EnvironmentOperationRequestSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .get_environment_operation_request(&project_root, &request_id)
            })
            .await
    }

    pub async fn decide_request(
        &self,
        request_id: String,
        record: EnvironmentOperationDecisionRecord,
    ) -> Result<usize, StoreExecutorError> {
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .decide_environment_operation_request(&request_id, &record)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::{EnvironmentOperationRequestDraft, Store};

    fn request(request_id: &str, project_root: &str) -> EnvironmentOperationRequestDraft {
        EnvironmentOperationRequestDraft {
            request_id: request_id.to_string(),
            turn_id: None,
            source: "user".to_string(),
            request_name: "renv_restore".to_string(),
            project_root: project_root.to_string(),
            arguments_json: "{}".to_string(),
            preview_json: "{}".to_string(),
            preview_sha256: format!("sha256.{request_id}"),
            workspace_id: "workspace.environment-repository".to_string(),
            state_revision: 2,
            project_revision: 3,
            before_snapshot_id: None,
        }
    }

    #[tokio::test]
    async fn repository_isolates_projects_and_recovers_after_rejected_decision() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        store
            .create_environment_operation_request(&request("request-a", "/projects/a"))
            .unwrap();
        store
            .create_environment_operation_request(&request("request-b", "/projects/b"))
            .unwrap();
        drop(store);

        let repository = StoreExecutor::open(&database)
            .await
            .unwrap()
            .environment_repository();
        let listed = repository
            .list_requests(
                "/projects/a/".to_string(),
                Some(10),
                Some("requested".to_string()),
            )
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].request_id, "request-a");
        assert!(
            repository
                .get_request("/projects/b".to_string(), "request-a".to_string())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            repository
                .decide_request(
                    "missing".to_string(),
                    EnvironmentOperationDecisionRecord {
                        decision: "cancel".to_string(),
                        status: "interrupted".to_string(),
                        reason: Some("missing channel".to_string()),
                    },
                )
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            repository
                .decide_request(
                    "request-a".to_string(),
                    EnvironmentOperationDecisionRecord {
                        decision: "cancel".to_string(),
                        status: "interrupted".to_string(),
                        reason: Some("missing channel".to_string()),
                    },
                )
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            repository
                .get_request("/projects/a".to_string(), "request-a".to_string())
                .await
                .unwrap()
                .unwrap()
                .status,
            "interrupted"
        );
    }
}
