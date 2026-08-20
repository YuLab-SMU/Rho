//! Mutation scenario tests for the shared application mutation service.
//!
//! These tests prove that `ProjectMutationService` correctly normalizes
//! project roots, scopes mutations to the given project, and returns stable
//! error categories — all without Tauri/DOM dependency.

use rho_store::{
    AgentTurnDraft, ArtifactRecordDraft, EvidenceEntryDraft, PlotArtifactDraft,
    ProjectMutationService, ProjectQueryService, RunDraft, Store,
};
use tempfile::tempdir;

fn setup_store() -> (Store, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path().join("rho.sqlite")).unwrap();
    (store, dir)
}

// ── request_cancel ───────────────────────────────────────────────────────

#[test]
fn scenario_request_cancel_success() {
    let (mut store, _dir) = setup_store();
    // Create a run that is still "running" (not finished).
    store
        .create_run(&RunDraft {
            run_id: "run_001".into(),
            parent_run_id: None,
            project_root: "/projects/alpha".into(),
            origin: "user".into(),
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

    let mut service = ProjectMutationService::new(&mut store);
    let cancelled = service
        .request_cancel("/projects/alpha", "run_001")
        .unwrap();
    assert!(cancelled);
}

#[test]
fn scenario_request_cancel_foreign_project() {
    let (mut store, _dir) = setup_store();
    // Create a run in project alpha.
    store
        .create_run(&RunDraft {
            run_id: "run_001".into(),
            parent_run_id: None,
            project_root: "/projects/alpha".into(),
            origin: "user".into(),
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

    let mut service = ProjectMutationService::new(&mut store);
    // Query from project beta — should not cancel.
    let cancelled = service.request_cancel("/projects/beta", "run_001").unwrap();
    assert!(!cancelled);
}

#[test]
fn scenario_request_cancel_normalizes_trailing_slash() {
    let (mut store, _dir) = setup_store();
    store
        .create_run(&RunDraft {
            run_id: "run_001".into(),
            parent_run_id: None,
            project_root: "/projects/alpha".into(),
            origin: "user".into(),
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

    let mut service = ProjectMutationService::new(&mut store);
    let cancelled = service
        .request_cancel("/projects/alpha/", "run_001")
        .unwrap();
    assert!(cancelled);
}

#[test]
fn scenario_request_cancel_finished_run_is_truthful_noop() {
    let (mut store, _dir) = setup_store();
    store
        .create_run(&rho_store::RunDraft {
            run_id: "run_001".into(),
            parent_run_id: None,
            project_root: "/projects/alpha".into(),
            origin: "user".into(),
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
        .finish_run(&rho_store::RunFinish {
            run_id: "run_001".into(),
            status: "completed".into(),
            terminal_reason: None,
            workspace_id: Some("ws_01".into()),
            state_revision_after: Some(2),
            project_revision_after: Some(2),
            stdout: None,
            value_text: None,
            messages: vec![],
            warnings: vec![],
            error_message: None,
            error_call: None,
            traceback: vec![],
            environment_snapshot_id_after: None,
        })
        .unwrap();

    let mut service = ProjectMutationService::new(&mut store);
    assert!(
        !service
            .request_cancel("/projects/alpha", "run_001")
            .unwrap()
    );
}

#[test]
fn scenario_mutation_rejects_blank_project_identity() {
    let (mut store, _dir) = setup_store();
    let mut service = ProjectMutationService::new(&mut store);
    assert!(matches!(
        service.clear_agent_history("  "),
        Err(rho_store::StoreError::Validation(message))
            if message == "project root identity is required"
    ));
}

// ── clear_agent_history ──────────────────────────────────────────────────

#[test]
fn scenario_clear_agent_history_success() {
    let (mut store, _dir) = setup_store();
    // Create an agent turn (which auto-creates a conversation).
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

    let mut service = ProjectMutationService::new(&mut store);
    let deleted = service.clear_agent_history("/projects/alpha").unwrap();
    assert!(deleted > 0);
}

#[test]
fn scenario_clear_agent_history_empty_project() {
    let (mut store, _dir) = setup_store();
    let mut service = ProjectMutationService::new(&mut store);
    let deleted = service.clear_agent_history("/projects/empty").unwrap();
    assert_eq!(deleted, 0);
}

#[test]
fn scenario_clear_agent_history_preserves_foreign_project() {
    let (mut store, _dir) = setup_store();
    for (turn_id, project_root) in [
        ("turn_alpha", "/projects/alpha"),
        ("turn_beta", "/projects/beta"),
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

    let deleted = ProjectMutationService::new(&mut store)
        .clear_agent_history("/projects/alpha/")
        .unwrap();
    assert!(deleted > 0);
    let query = ProjectQueryService::new(&store);
    assert!(
        query
            .list_agent_conversations("/projects/alpha", None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        query
            .list_agent_conversations("/projects/beta", None)
            .unwrap()
            .len(),
        1
    );
}

// ── create_evidence_entry + delete_evidence_entry ─────────────────────────

#[test]
fn scenario_create_and_delete_evidence_entry() {
    let (mut store, _dir) = setup_store();
    let mut service = ProjectMutationService::new(&mut store);

    let entry = service
        .create_evidence_entry(&EvidenceEntryDraft {
            project_root: "/projects/alpha".into(),
            title: "Test evidence".into(),
            notes: "Some notes".into(),
            doi: None,
            run_id: None,
            artifact_id: None,
        })
        .unwrap();
    assert!(entry.id > 0);

    let deleted = service
        .delete_evidence_entry("/projects/alpha", entry.id)
        .unwrap();
    assert!(deleted);
}

#[test]
fn scenario_delete_evidence_entry_foreign_project() {
    let (mut store, _dir) = setup_store();
    let mut service = ProjectMutationService::new(&mut store);

    let entry = service
        .create_evidence_entry(&EvidenceEntryDraft {
            project_root: "/projects/alpha".into(),
            title: "Test evidence".into(),
            notes: "Some notes".into(),
            doi: None,
            run_id: None,
            artifact_id: None,
        })
        .unwrap();

    // Try to delete from project beta — should fail (false).
    let deleted = service
        .delete_evidence_entry("/projects/beta", entry.id)
        .unwrap();
    assert!(!deleted);
}

#[test]
fn scenario_create_evidence_entry_normalizes_trailing_slash() {
    let (mut store, _dir) = setup_store();
    let mut service = ProjectMutationService::new(&mut store);

    let entry = service
        .create_evidence_entry(&EvidenceEntryDraft {
            project_root: "/projects/alpha/".into(),
            title: "Test".into(),
            notes: "".into(),
            doi: None,
            run_id: None,
            artifact_id: None,
        })
        .unwrap();
    assert!(entry.id > 0);
}

// ── delete_agent_conversation ─────────────────────────────────────────────

#[test]
fn scenario_delete_agent_conversation_success() {
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
    // The turn was created with status 'running'. We need to finish it first.
    store
        .finish_agent_turn(&rho_store::AgentTurnFinish {
            turn_id: "turn_001".into(),
            status: "completed".into(),
            terminal_reason: None,
            workspace_id_after: Some("ws_01".into()),
            state_revision_after: Some(2),
            project_revision_after: Some(2),
            final_message: Some("Done".into()),
            error_message: None,
        })
        .unwrap();

    let mut service = ProjectMutationService::new(&mut store);
    let deleted = service
        .delete_agent_conversation("/projects/alpha", "conversation_turn_001")
        .unwrap();
    assert!(deleted > 0);
}

#[test]
fn scenario_delete_agent_conversation_foreign_project() {
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
    store
        .finish_agent_turn(&rho_store::AgentTurnFinish {
            turn_id: "turn_001".into(),
            status: "completed".into(),
            terminal_reason: None,
            workspace_id_after: Some("ws_01".into()),
            state_revision_after: Some(2),
            project_revision_after: Some(2),
            final_message: Some("Done".into()),
            error_message: None,
        })
        .unwrap();

    let mut service = ProjectMutationService::new(&mut store);
    // Try to delete from project beta — should error (not found).
    let result = service.delete_agent_conversation("/projects/beta", "conversation_turn_001");
    assert!(result.is_err());
}

// ── Cross-service: query reads what mutation wrote ────────────────────────

#[test]
fn scenario_mutation_then_query_consistent() {
    let (mut store, _dir) = setup_store();
    let entry = {
        let mut mutation = ProjectMutationService::new(&mut store);
        mutation
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "/projects/alpha".into(),
                title: "Cross-service test".into(),
                notes: "Created via mutation service".into(),
                doi: Some("10.1000/test".into()),
                run_id: None,
                artifact_id: None,
            })
            .unwrap()
    };

    // Read back via the store directly.
    let read_back = store
        .get_evidence_entry("/projects/alpha", entry.id)
        .unwrap();
    assert!(read_back.is_some());
    let read_back = read_back.unwrap();
    assert_eq!(read_back.title, "Cross-service test");
    assert_eq!(read_back.doi, Some("10.1000/test".into()));

    // Delete via mutation service.
    let deleted = {
        let mut mutation = ProjectMutationService::new(&mut store);
        mutation
            .delete_evidence_entry("/projects/alpha", entry.id)
            .unwrap()
    };
    assert!(deleted);

    // Verify it's gone.
    let read_back = store
        .get_evidence_entry("/projects/alpha", entry.id)
        .unwrap();
    assert!(read_back.is_none());
}

#[test]
fn scenario_artifact_and_plot_clears_require_explicit_project_scope() {
    let (mut store, _dir) = setup_store();
    for (suffix, project_root) in [("alpha", "/projects/alpha"), ("beta", "/projects/beta")] {
        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: format!("artifact_{suffix}"),
                artifact_kind: "render_output".into(),
                run_id: None,
                project_root: project_root.into(),
                output_path: format!("reports/{suffix}.html"),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: Some("ws_01".into()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "text/html".into(),
                metadata_json: "{}".into(),
                provenance_complete: true,
                incomplete_reason: None,
            })
            .unwrap();
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: format!("plot_{suffix}"),
                run_id: format!("run_{suffix}"),
                project_root: Some(project_root.into()),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: Some("ws_01".into()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".into(),
                payload_json: "{\"image/png\":\"abc\"}".into(),
                provenance_complete: true,
            })
            .unwrap();
    }

    let mut service = ProjectMutationService::new(&mut store);
    assert_eq!(
        service
            .clear_artifact_records("/projects/alpha/", None, false)
            .unwrap(),
        1
    );
    assert_eq!(
        service
            .clear_plot_artifacts("/projects/alpha/", None, false)
            .unwrap(),
        1
    );

    assert!(
        store
            .list_artifact_records(None, "/projects/alpha", None, false)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_artifact_records(None, "/projects/beta", None, false)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list_plot_artifacts(None, Some("/projects/alpha"), None, false)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_plot_artifacts(None, Some("/projects/beta"), None, false)
            .unwrap()
            .len(),
        1
    );
}
