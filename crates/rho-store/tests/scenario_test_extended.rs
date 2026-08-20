//! Extended scenario tests for the shared application service seam.
//!
//! These tests exercise the newly added methods on `ProjectQueryService`:
//! - `compare_runs`
//! - `list_approval_requests`
//! - `list_agent_conversations`
//! - `list_agent_turns`
//! - `get_agent_turn_detail`
//!
//! Each test creates a temporary store, populates it with realistic data,
//! then queries it via the same `ProjectQueryService` that the Tauri commands
//! now use. This proves that the shared service works independently of
//! Tauri/DOM state and that project isolation, normalization, and bounded
//! results are correct.

use rho_store::{
    AgentTurnDraft, ApprovalRequestDraft, ProjectQueryService, RunDraft, RunFinish, Store,
};
use tempfile::tempdir;

// ── Test fixtures ────────────────────────────────────────────────────────

fn setup_store() -> (Store, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path().join("rho.sqlite")).unwrap();
    (store, dir)
}

fn create_run(store: &mut Store, project_root: &str, run_id: &str, has_error: bool) {
    store
        .create_run(&RunDraft {
            run_id: run_id.into(),
            parent_run_id: None,
            project_root: project_root.into(),
            origin: "user".into(),
            request_type: "execute_r".into(),
            operation_class: "scientific".into(),
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

fn create_approval_request(store: &mut Store, project_root: &str, request_id: &str, turn_id: &str) {
    // First create the agent turn (required by FK constraint on approval_requests).
    store
        .create_agent_turn(&AgentTurnDraft {
            turn_id: turn_id.into(),
            project_root: project_root.into(),
            mode: "chat".into(),
            prompt: "test prompt".into(),
            model: "gpt-4".into(),
            workspace_id: "ws_01".into(),
            state_revision_before: 1,
            project_revision_before: 1,
        })
        .unwrap();
    store
        .create_approval_request(&ApprovalRequestDraft {
            request_id: request_id.into(),
            turn_id: turn_id.into(),
            project_root: project_root.into(),
            tool: "file_edit".into(),
            policy: "auto_approve".into(),
            arguments_json: "{}".into(),
            code: None,
            workspace_id: "ws_01".into(),
            state_revision: 1,
            project_revision: 1,
        })
        .unwrap();
}

// ── list_agent_conversations ──────────────────────────────────────────────

#[test]
fn scenario_list_agent_conversations() {
    let (mut store, _dir) = setup_store();

    // Create conversations by creating agent turns (which auto-creates conversations).
    store
        .create_agent_turn(&AgentTurnDraft {
            turn_id: "turn_001".into(),
            project_root: "/projects/alpha".into(),
            mode: "chat".into(),
            prompt: "What is 1+1?".into(),
            model: "gpt-4".into(),
            workspace_id: "ws_01".into(),
            state_revision_before: 1,
            project_revision_before: 1,
        })
        .unwrap();
    store
        .create_agent_turn(&AgentTurnDraft {
            turn_id: "turn_002".into(),
            project_root: "/projects/alpha".into(),
            mode: "chat".into(),
            prompt: "What is 2+2?".into(),
            model: "gpt-4".into(),
            workspace_id: "ws_01".into(),
            state_revision_before: 1,
            project_revision_before: 1,
        })
        .unwrap();
    store
        .create_agent_turn(&AgentTurnDraft {
            turn_id: "turn_003".into(),
            project_root: "/projects/beta".into(),
            mode: "chat".into(),
            prompt: "Hello".into(),
            model: "gpt-4".into(),
            workspace_id: "ws_01".into(),
            state_revision_before: 1,
            project_revision_before: 1,
        })
        .unwrap();

    let service = ProjectQueryService::new(&store);

    let alpha = service
        .list_agent_conversations("/projects/alpha", None)
        .unwrap();
    assert_eq!(alpha.len(), 2);

    let beta = service
        .list_agent_conversations("/projects/beta", None)
        .unwrap();
    assert_eq!(beta.len(), 1);

    let empty = service
        .list_agent_conversations("/projects/gamma", None)
        .unwrap();
    assert!(empty.is_empty());
}

#[test]
fn scenario_list_agent_conversations_normalizes_trailing_slash() {
    let (mut store, _dir) = setup_store();
    store
        .create_agent_turn(&AgentTurnDraft {
            turn_id: "turn_001".into(),
            project_root: "/projects/alpha".into(),
            mode: "chat".into(),
            prompt: "Hello".into(),
            model: "gpt-4".into(),
            workspace_id: "ws_01".into(),
            state_revision_before: 1,
            project_revision_before: 1,
        })
        .unwrap();

    let service = ProjectQueryService::new(&store);
    let convs = service
        .list_agent_conversations("/projects/alpha/", None)
        .unwrap();
    assert_eq!(convs.len(), 1);
}

// ── list_approval_requests ────────────────────────────────────────────────

#[test]
fn scenario_list_approval_requests() {
    let (mut store, _dir) = setup_store();
    create_approval_request(&mut store, "/projects/alpha", "appr_001", "turn_001");

    let service = ProjectQueryService::new(&store);

    let all = service
        .list_approval_requests("/projects/alpha", None, None)
        .unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].request_id, "appr_001");

    let waiting = service
        .list_approval_requests("/projects/alpha", None, Some("waiting"))
        .unwrap();
    assert_eq!(waiting.len(), 1);

    let other = service
        .list_approval_requests("/projects/alpha", None, Some("responded"))
        .unwrap();
    assert!(other.is_empty());

    let foreign = service
        .list_approval_requests("/projects/beta", None, None)
        .unwrap();
    assert!(foreign.is_empty());
}

#[test]
fn scenario_list_approval_requests_normalizes_trailing_slash() {
    let (mut store, _dir) = setup_store();
    create_approval_request(&mut store, "/projects/alpha", "appr_001", "turn_001");

    let service = ProjectQueryService::new(&store);
    let requests = service
        .list_approval_requests("/projects/alpha/", None, None)
        .unwrap();
    assert_eq!(requests.len(), 1);
}

// ── get_agent_turn_detail ─────────────────────────────────────────────────

#[test]
fn scenario_get_agent_turn_detail_not_found() {
    let (store, _dir) = setup_store();
    let service = ProjectQueryService::new(&store);
    let detail = service
        .get_agent_turn_detail("/projects/alpha", "nonexistent_turn")
        .unwrap();
    assert!(detail.is_none());
}

#[test]
fn scenario_get_agent_turn_detail_foreign_project() {
    let (mut store, _dir) = setup_store();
    store
        .create_agent_turn(&AgentTurnDraft {
            turn_id: "turn_001".into(),
            project_root: "/projects/alpha".into(),
            mode: "chat".into(),
            prompt: "Hello".into(),
            model: "gpt-4".into(),
            workspace_id: "ws_01".into(),
            state_revision_before: 1,
            project_revision_before: 1,
        })
        .unwrap();

    let service = ProjectQueryService::new(&store);

    // Query from project beta — should return None.
    let detail = service
        .get_agent_turn_detail("/projects/beta", "turn_001")
        .unwrap();
    assert!(detail.is_none());
}

#[test]
fn scenario_list_agent_turns_and_detail_are_conversation_and_project_scoped() {
    let (mut store, _dir) = setup_store();
    for (turn_id, project_root) in [
        ("turn_alpha_1", "/projects/alpha"),
        ("turn_alpha_2", "/projects/alpha"),
        ("turn_beta_1", "/projects/beta"),
    ] {
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.into(),
                project_root: project_root.into(),
                mode: "chat".into(),
                prompt: "Hello".into(),
                model: "gpt-4".into(),
                workspace_id: "ws_01".into(),
                state_revision_before: 1,
                project_revision_before: 1,
            })
            .unwrap();
    }

    let service = ProjectQueryService::new(&store);
    let alpha = service
        .list_agent_turns("/projects/alpha/", None, None)
        .unwrap();
    assert_eq!(alpha.len(), 2);
    assert!(
        alpha
            .iter()
            .all(|turn| turn.project_root == "/projects/alpha")
    );

    let filtered = service
        .list_agent_turns("/projects/alpha", Some("conversation_turn_alpha_1"), None)
        .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].turn_id, "turn_alpha_1");

    let foreign_filter = service
        .list_agent_turns("/projects/beta", Some("conversation_turn_alpha_1"), None)
        .unwrap();
    assert!(foreign_filter.is_empty());

    let detail = service
        .get_agent_turn_detail("/projects/alpha/", "turn_alpha_1")
        .unwrap()
        .unwrap();
    assert_eq!(detail.turn.turn_id, "turn_alpha_1");
    assert_eq!(detail.turn.project_root, "/projects/alpha");
}

// ── compare_runs ──────────────────────────────────────────────────────────

#[test]
fn scenario_compare_runs_same_id_error() {
    let (mut store, _dir) = setup_store();
    create_run(&mut store, "/projects/alpha", "run_001", false);

    let service = ProjectQueryService::new(&store);
    let result = service.compare_runs("/projects/alpha", "run_001", "run_001");
    assert!(result.is_err());
}

#[test]
fn scenario_compare_runs_not_found_error() {
    let (mut store, _dir) = setup_store();
    create_run(&mut store, "/projects/alpha", "run_001", false);

    let service = ProjectQueryService::new(&store);
    let result = service.compare_runs("/projects/alpha", "run_001", "nonexistent");
    assert!(result.is_err());
}

#[test]
fn scenario_compare_runs_success() {
    let (mut store, _dir) = setup_store();
    create_run(&mut store, "/projects/alpha", "run_001", false);
    create_run(&mut store, "/projects/alpha", "run_002", false);

    let service = ProjectQueryService::new(&store);
    let result = service
        .compare_runs("/projects/alpha", "run_001", "run_002")
        .unwrap();
    assert_eq!(result.left_run_id, "run_001");
    assert_eq!(result.right_run_id, "run_002");
}

#[test]
fn scenario_compare_runs_foreign_project() {
    let (mut store, _dir) = setup_store();
    create_run(&mut store, "/projects/alpha", "run_001", false);
    create_run(&mut store, "/projects/beta", "run_002", false);

    let service = ProjectQueryService::new(&store);
    // run_002 is in project beta, not alpha — compare_runs should error.
    let result = service.compare_runs("/projects/alpha", "run_001", "run_002");
    assert!(result.is_err());
}
