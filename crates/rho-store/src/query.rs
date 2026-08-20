//! Shared read-only application query service for project-scoped data.
//!
//! This module provides [`ProjectQueryService`], a thin typed wrapper over
//! [`Store`] that normalizes project roots consistently and delegates to
//! existing store query methods. It is the shared application seam used by
//! both Tauri commands and deterministic scenario tests, ensuring that the
//! same business logic (normalization, scoping, bounded results) is exercised
//! in both paths.
//!
//! ## Design constraints
//!
//! * No `tauri` / TUI / DOM dependency — depends only on `rho-store` types.
//! * No new SQLite, runtime, project, credential, or approval authority.
//! * No schema / persistence / public protocol change.
//! * Bounded results via `limit` parameter (default 50, matching `Store`).
//! * Stable error category via `StoreError`.

use crate::{ProblemSummary, RunDetail, RunSummary, Store, StoreError, normalize_project_root};

/// Read-only application query service for project-scoped data.
///
/// Each query method normalizes the project root using
/// [`normalize_project_root`] before delegating to the underlying [`Store`]
/// method. This ensures consistent path handling across all adapters (Tauri,
/// CLI, MCP, tests) and fixes a pre-existing drift where some Tauri commands
/// used `replace('\\', "/")` (lightweight) while others used
/// `normalize_project_root` (full).
pub struct ProjectQueryService<'a> {
    store: &'a Store,
}

impl<'a> ProjectQueryService<'a> {
    /// Create a new query service wrapping the given store reference.
    pub fn new(store: &'a Store) -> Self {
        Self { store }
    }

    /// List runs for the given project, ordered by `started_at DESC`.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying. Returns an empty vector if no runs match.
    pub fn list_runs(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<RunSummary>, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.list_runs(&normalized, limit)
    }

    /// List problems (runs with `error_message IS NOT NULL`) for the given
    /// project.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying. Returns an empty vector if no problems match.
    pub fn list_problems(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<ProblemSummary>, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.list_problems(&normalized, limit)
    }

    /// Get detail for a single run.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying. Returns `None` if the run does not exist or does not belong
    /// to the given project.
    pub fn get_run_detail(
        &self,
        project_root: &str,
        run_id: &str,
    ) -> Result<Option<RunDetail>, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.get_run_detail(&normalized, run_id)
    }

    /// Compare two runs within the same project.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying. Both runs must belong to the given project and have
    /// `operation_class = "scientific"`.
    pub fn compare_runs(
        &self,
        project_root: &str,
        left_run_id: &str,
        right_run_id: &str,
    ) -> Result<crate::CompareRunsResponse, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store
            .compare_runs(&normalized, left_run_id, right_run_id)
    }

    /// List approval requests for the given project.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying. Optionally filter by status (e.g. `"waiting"`).
    pub fn list_approval_requests(
        &self,
        project_root: &str,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<crate::ApprovalRequestSummary>, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store
            .list_approval_requests(&normalized, limit, status)
    }

    /// List agent conversations for the given project.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying.
    pub fn list_agent_conversations(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<crate::AgentConversationSummary>, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.list_agent_conversations(&normalized, limit)
    }

    /// List agent turns for the given project, optionally filtered by
    /// conversation.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying.
    pub fn list_agent_turns(
        &self,
        project_root: &str,
        conversation_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<crate::AgentTurnSummary>, StoreError> {
        let normalized = required_project_root(project_root)?;
        match conversation_id {
            Some(cid) => self
                .store
                .list_agent_turns_for_conversation(&normalized, cid, limit),
            None => self.store.list_agent_turns(&normalized, limit),
        }
    }

    /// Get detail for a single agent turn.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying. Returns `None` if the turn does not exist or does not belong
    /// to the given project.
    pub fn get_agent_turn_detail(
        &self,
        project_root: &str,
        turn_id: &str,
    ) -> Result<Option<crate::AgentTurnDetail>, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.get_agent_turn_detail(&normalized, turn_id)
    }
}

pub(crate) fn required_project_root(project_root: &str) -> Result<String, StoreError> {
    let normalized = normalize_project_root(project_root);
    if normalized.trim().is_empty() {
        return Err(StoreError::Validation(
            "project root identity is required".to_string(),
        ));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RunDraft, RunFinish};
    use tempfile::tempdir;

    fn setup_store() -> (Store, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let store = Store::open(dir.path().join("rho.sqlite")).unwrap();
        (store, dir)
    }

    fn create_test_run(
        store: &mut Store,
        project_root: &str,
        run_id: &str,
        origin: &str,
        has_error: bool,
    ) {
        store
            .create_run(&RunDraft {
                run_id: run_id.into(),
                parent_run_id: None,
                project_root: project_root.into(),
                origin: origin.into(),
                request_type: "execute_r".into(),
                operation_class: "StateCapable".into(),
                code: "1 + 1".into(),
                arguments_json: "{}".into(),
                source_path: Some("test.R".into()),
                execution_mode: None,
                document_version: None,
                workspace_id: "ws_01".into(),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: run_id.into(),
                status: if has_error { "failed" } else { "completed" }.into(),
                terminal_reason: None,
                workspace_id: Some("ws_01".into()),
                state_revision_after: Some(2),
                project_revision_after: Some(2),
                stdout: Some("> 1 + 1\n[1] 2".into()),
                value_text: Some("2".into()),
                messages: vec!["hello".into()],
                warnings: vec![],
                error_message: if has_error {
                    Some("Error: object not found".into())
                } else {
                    None
                },
                error_call: None,
                traceback: vec![],
                environment_snapshot_id_after: None,
            })
            .unwrap();
    }

    // ── list_runs ──────────────────────────────────────────────────────────

    #[test]
    fn list_runs_success() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", false);
        create_test_run(&mut store, "/projects/alpha", "run_002", "user", false);

        let service = ProjectQueryService::new(&store);
        let runs = service.list_runs("/projects/alpha", None).unwrap();
        assert_eq!(runs.len(), 2);
        // Ordered by started_at DESC — most recent first.
        assert_eq!(runs[0].run_id, "run_002");
        assert_eq!(runs[1].run_id, "run_001");
    }

    #[test]
    fn list_runs_empty() {
        let (store, _dir) = setup_store();
        let service = ProjectQueryService::new(&store);
        let runs = service.list_runs("/projects/empty", None).unwrap();
        assert!(runs.is_empty());
    }

    #[test]
    fn blank_project_root_is_rejected() {
        let (store, _dir) = setup_store();
        let service = ProjectQueryService::new(&store);
        assert!(matches!(
            service.list_runs("  ", None),
            Err(StoreError::Validation(message)) if message == "project root identity is required"
        ));
    }

    #[test]
    fn list_runs_foreign_project_excluded() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", false);
        create_test_run(&mut store, "/projects/beta", "run_002", "user", false);

        let service = ProjectQueryService::new(&store);
        let runs = service.list_runs("/projects/alpha", None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "run_001");
    }

    #[test]
    fn list_runs_normalizes_trailing_slash() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", false);

        let service = ProjectQueryService::new(&store);
        // Trailing slash should be normalized away.
        let runs = service.list_runs("/projects/alpha/", None).unwrap();
        assert_eq!(runs.len(), 1);
    }

    #[test]
    fn list_runs_respects_limit() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", false);
        create_test_run(&mut store, "/projects/alpha", "run_002", "user", false);
        create_test_run(&mut store, "/projects/alpha", "run_003", "user", false);

        let service = ProjectQueryService::new(&store);
        let runs = service.list_runs("/projects/alpha", Some(2)).unwrap();
        assert_eq!(runs.len(), 2);
    }

    // ── list_problems ──────────────────────────────────────────────────────

    #[test]
    fn list_problems_success() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", true);
        create_test_run(&mut store, "/projects/alpha", "run_002", "user", false);

        let service = ProjectQueryService::new(&store);
        let problems = service.list_problems("/projects/alpha", None).unwrap();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].run_id, "run_001");
        assert_eq!(problems[0].message, "Error: object not found");
    }

    #[test]
    fn list_problems_empty() {
        let (store, _dir) = setup_store();
        let service = ProjectQueryService::new(&store);
        let problems = service.list_problems("/projects/empty", None).unwrap();
        assert!(problems.is_empty());
    }

    #[test]
    fn list_problems_foreign_project_excluded() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", true);
        create_test_run(&mut store, "/projects/beta", "run_002", "user", true);

        let service = ProjectQueryService::new(&store);
        let problems = service.list_problems("/projects/alpha", None).unwrap();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].run_id, "run_001");
    }

    #[test]
    fn list_problems_normalizes_trailing_slash() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", true);

        let service = ProjectQueryService::new(&store);
        let problems = service.list_problems("/projects/alpha/", None).unwrap();
        assert_eq!(problems.len(), 1);
    }

    // ── get_run_detail ─────────────────────────────────────────────────────

    #[test]
    fn get_run_detail_success() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", false);

        let service = ProjectQueryService::new(&store);
        let detail = service
            .get_run_detail("/projects/alpha", "run_001")
            .unwrap();
        assert!(detail.is_some());
        let detail = detail.unwrap();
        assert_eq!(detail.run_id, "run_001");
        assert_eq!(detail.status, "completed");
    }

    #[test]
    fn get_run_detail_not_found() {
        let (store, _dir) = setup_store();
        let service = ProjectQueryService::new(&store);
        let detail = service
            .get_run_detail("/projects/alpha", "nonexistent")
            .unwrap();
        assert!(detail.is_none());
    }

    #[test]
    fn get_run_detail_foreign_project_excluded() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", false);

        let service = ProjectQueryService::new(&store);
        // Query for project beta — should return None even though run_001 exists.
        let detail = service.get_run_detail("/projects/beta", "run_001").unwrap();
        assert!(detail.is_none());
    }

    #[test]
    fn get_run_detail_normalizes_trailing_slash() {
        let (mut store, _dir) = setup_store();
        create_test_run(&mut store, "/projects/alpha", "run_001", "user", false);

        let service = ProjectQueryService::new(&store);
        // Trailing slash should be normalized away.
        let detail = service
            .get_run_detail("/projects/alpha/", "run_001")
            .unwrap();
        assert!(detail.is_some());
    }
}
