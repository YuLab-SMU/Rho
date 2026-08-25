//! Coherent durable project-transition projections and active-root writes.

use crate::{
    ApprovalRequestSummary, EnvironmentOperationRequestSummary, Store, StoreExecutor,
    StoreExecutorError, query::required_project_root,
};

#[derive(Clone, Debug)]
pub struct ProjectTransitionSnapshot {
    pub active_project_root: String,
    pub active_run_id: Option<String>,
    pub waiting_approvals: Vec<ApprovalRequestSummary>,
    pub environment_status: Option<String>,
    pub environment_requests: Vec<EnvironmentOperationRequestSummary>,
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
                let waiting_approvals = store.list_approval_requests(
                    &active_project_root,
                    Some(10),
                    Some("waiting"),
                )?;
                let mut environment_status = None;
                let mut environment_requests = Vec::new();
                for status in ["running", "approved", "requested"] {
                    let requests = store.list_environment_operation_requests(
                        &active_project_root,
                        Some(10),
                        Some(status),
                    )?;
                    if !requests.is_empty() {
                        environment_status = Some(status.to_string());
                        environment_requests = requests;
                        break;
                    }
                }
                Ok(ProjectTransitionSnapshot {
                    active_project_root,
                    active_run_id,
                    waiting_approvals,
                    environment_status,
                    environment_requests,
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
    use crate::{
        AgentConversationDraft, AgentTurnDraft, ApprovalRequestDraft,
        EnvironmentOperationRequestDraft, RunDraft,
    };

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

    fn create_waiting_approval(store: &mut Store, project_root: &str, suffix: &str) {
        let conversation_id = format!("conversation-{suffix}");
        let turn_id = format!("turn-{suffix}");
        store
            .create_agent_turn_with_conversation(
                &AgentConversationDraft {
                    conversation_id,
                    project_root: project_root.to_string(),
                    title: format!("Conversation {suffix}"),
                    legacy_unthreaded: false,
                },
                &AgentTurnDraft {
                    turn_id: turn_id.clone(),
                    project_root: project_root.to_string(),
                    mode: "act".to_string(),
                    prompt: "Run code".to_string(),
                    model: "test".to_string(),
                    workspace_id: format!("workspace.{suffix}"),
                    state_revision_before: 1,
                    project_revision_before: 1,
                },
            )
            .unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: format!("approval-{suffix}"),
                turn_id,
                project_root: project_root.to_string(),
                tool: "run_r".to_string(),
                policy: "required".to_string(),
                arguments_json: "{}".to_string(),
                code: None,
                workspace_id: format!("workspace.{suffix}"),
                state_revision: 1,
                project_revision: 1,
            })
            .unwrap();
    }

    fn create_environment_request(store: &mut Store, project_root: &str, suffix: &str) {
        store
            .create_environment_operation_request(&EnvironmentOperationRequestDraft {
                request_id: format!("environment-{suffix}"),
                turn_id: None,
                source: "user".to_string(),
                request_name: "renv_restore".to_string(),
                project_root: project_root.to_string(),
                arguments_json: "{}".to_string(),
                preview_json: "{}".to_string(),
                preview_sha256: format!("sha256.{suffix}"),
                workspace_id: format!("workspace.{suffix}"),
                state_revision: 1,
                project_revision: 1,
                before_snapshot_id: None,
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
        create_waiting_approval(&mut store, "/projects/a", "a");
        create_waiting_approval(&mut store, "/projects/b", "b");
        create_environment_request(&mut store, "/projects/a", "a");
        create_environment_request(&mut store, "/projects/b", "b");
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
        assert_eq!(project_a.waiting_approvals.len(), 1);
        assert_eq!(project_a.waiting_approvals[0].request_id, "approval-a");
        assert_eq!(project_a.environment_status.as_deref(), Some("requested"));
        assert_eq!(project_a.environment_requests.len(), 1);
        assert_eq!(
            project_a.environment_requests[0].request_id,
            "environment-a"
        );

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
        assert_eq!(project_b.waiting_approvals[0].request_id, "approval-b");
        assert_eq!(
            project_b.environment_requests[0].request_id,
            "environment-b"
        );

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
