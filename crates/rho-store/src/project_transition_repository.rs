//! Coherent durable project-transition projections and active-root writes.

use crate::{
    EnvironmentOperationActivity, Store, StoreExecutor, StoreExecutorError,
    query::required_project_root,
};

#[derive(Clone, Debug)]
pub struct ProjectTransitionSnapshot {
    pub active_project_root: String,
    pub active_run_id: Option<String>,
    pub environment_operation: Option<EnvironmentOperationActivity>,
}

#[derive(Clone, Debug)]
pub struct ProjectTransitionRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn project_transition_repository(&self) -> ProjectTransitionRepository {
        ProjectTransitionRepository {
            executor: self.clone(),
        }
    }
}

impl ProjectTransitionRepository {
    pub async fn snapshot(
        &self,
        fallback_project_root: String,
    ) -> Result<ProjectTransitionSnapshot, StoreExecutorError> {
        let fallback_project_root = required_project_root(&fallback_project_root)?;
        self.executor
            .call(move |connection| {
                let store = Store::borrowed(connection);
                let active_project_root = store
                    .active_project_root()?
                    .unwrap_or(fallback_project_root);
                let active_run_id = store.latest_active_run_id(&active_project_root)?;
                let environment_operation =
                    store.active_environment_operation(&active_project_root)?;
                Ok(ProjectTransitionSnapshot {
                    active_project_root,
                    active_run_id,
                    environment_operation,
                })
            })
            .await
    }

    pub async fn active_project_root(&self) -> Result<Option<String>, StoreExecutorError> {
        self.executor
            .call(move |connection| Store::borrowed(connection).active_project_root())
            .await
    }

    pub async fn set_active_project_root(
        &self,
        project_root: Option<String>,
    ) -> Result<(), StoreExecutorError> {
        let project_root = project_root
            .map(|root| required_project_root(&root))
            .transpose()?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).set_project_root(project_root.as_deref())
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::RunDraft;

    fn create_active_run(store: &mut Store, project_root: &str, run_id: &str) {
        store
            .create_run(&RunDraft {
                run_id: run_id.to_string(),
                parent_run_id: None,
                project_root: project_root.to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "scientific".to_string(),
                code: "Sys.sleep(10)".to_string(),
                arguments_json: "{}".to_string(),
                source_path: None,
                execution_mode: Some("console".to_string()),
                document_version: None,
                workspace_id: format!("workspace.{run_id}"),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn snapshot_and_active_root_writes_preserve_project_isolation_and_recovery() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        store.set_project_root(Some("/projects/a")).unwrap();
        create_active_run(&mut store, "/projects/a", "run-a");
        create_active_run(&mut store, "/projects/b", "run-b");
        drop(store);

        let repository = StoreExecutor::open(&database)
            .await
            .unwrap()
            .project_transition_repository();
        assert!(repository.snapshot(" ".to_string()).await.is_err());
        let project_a = repository
            .snapshot("/projects/fallback".to_string())
            .await
            .unwrap();
        assert_eq!(project_a.active_project_root, "/projects/a");
        assert_eq!(project_a.active_run_id.as_deref(), Some("run-a"));
        assert!(project_a.environment_operation.is_none());

        repository
            .set_active_project_root(Some("/projects/b/".to_string()))
            .await
            .unwrap();
        assert_eq!(
            repository.active_project_root().await.unwrap().as_deref(),
            Some("/projects/b")
        );
        let project_b = repository
            .snapshot("/projects/fallback".to_string())
            .await
            .unwrap();
        assert_eq!(project_b.active_run_id.as_deref(), Some("run-b"));
        assert!(project_b.environment_operation.is_none());

        repository.set_active_project_root(None).await.unwrap();
        assert!(repository.active_project_root().await.unwrap().is_none());
        assert_eq!(
            repository
                .snapshot("/projects/fallback/".to_string())
                .await
                .unwrap()
                .active_project_root,
            "/projects/fallback"
        );
    }
}
