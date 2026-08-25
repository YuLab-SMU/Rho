//! Asynchronous project-scoped Run History queries.
//!
//! The repository is a cloneable facade over the application's one
//! [`StoreExecutor`](crate::StoreExecutor). It owns no connection or query
//! semantics; every call delegates to the existing [`Store`](crate::Store)
//! implementation on that executor's worker.

use crate::{
    CompareRunsResponse, ProblemSummary, RunDetail, RunSummary, Store, StoreExecutor,
    StoreExecutorError, query::required_project_root,
};

#[derive(Clone, Debug)]
pub struct RunRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn run_repository(&self) -> RunRepository {
        RunRepository {
            executor: self.clone(),
        }
    }
}

impl RunRepository {
    pub async fn list_runs(
        &self,
        project_root: String,
        limit: Option<usize>,
    ) -> Result<Vec<RunSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| Store::borrowed(connection).list_runs(&project_root, limit))
            .await
    }

    pub async fn list_problems(
        &self,
        project_root: String,
        limit: Option<usize>,
    ) -> Result<Vec<ProblemSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| Store::borrowed(connection).list_problems(&project_root, limit))
            .await
    }

    pub async fn get_run_detail(
        &self,
        project_root: String,
        run_id: String,
    ) -> Result<Option<RunDetail>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).get_run_detail(&project_root, &run_id)
            })
            .await
    }

    pub async fn compare_runs(
        &self,
        project_root: String,
        left_run_id: String,
        right_run_id: String,
    ) -> Result<CompareRunsResponse, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).compare_runs(&project_root, &left_run_id, &right_run_id)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::{RunDraft, RunFinish};

    fn create_run(store: &mut Store, project_root: &str, run_id: &str, has_error: bool) {
        store
            .create_run(&RunDraft {
                run_id: run_id.to_string(),
                parent_run_id: None,
                project_root: project_root.to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "scientific".to_string(),
                code: "1 + 1".to_string(),
                arguments_json: "{}".to_string(),
                source_path: Some("test.R".to_string()),
                execution_mode: None,
                document_version: None,
                workspace_id: "workspace.run-repository".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: run_id.to_string(),
                status: if has_error { "failed" } else { "completed" }.to_string(),
                terminal_reason: None,
                workspace_id: Some("workspace.run-repository".to_string()),
                state_revision_after: Some(2),
                project_revision_after: Some(1),
                stdout: Some("[1] 2".to_string()),
                value_text: Some("2".to_string()),
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: has_error.then(|| "object not found".to_string()),
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: None,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn run_repository_preserves_queries_bounds_and_project_isolation() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        create_run(&mut store, "/projects/a", "run-a-1", false);
        create_run(&mut store, "/projects/a", "run-a-2", true);
        create_run(&mut store, "/projects/b", "run-b-1", true);
        drop(store);

        let repository = StoreExecutor::open(&database)
            .await
            .unwrap()
            .run_repository();
        let runs = repository
            .list_runs("/projects/a/".to_string(), Some(1))
            .await
            .unwrap();
        assert_eq!(runs.len(), 1);
        assert!(runs[0].run_id.starts_with("run-a-"));
        let problems = repository
            .list_problems("/projects/a".to_string(), None)
            .await
            .unwrap();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].run_id, "run-a-2");
        assert!(
            repository
                .get_run_detail("/projects/b".to_string(), "run-a-1".to_string())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            repository
                .compare_runs(
                    "/projects/a".to_string(),
                    "run-a-1".to_string(),
                    "run-a-2".to_string(),
                )
                .await
                .unwrap()
                .left_run_id,
            "run-a-1"
        );
    }
}
