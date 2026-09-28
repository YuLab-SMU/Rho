//! Prove the temporary composition uses a separate Agent-owned database.
use rho_application::{AgentTaskOwner, AgentTaskRepository, AgentTaskScope};
use rho_contract::{AgentControllerRef, AgentProvider, AgentTaskCommand, AgentTaskRequest};
use rho_sqlite::ApplicationStore;
use rusqlite::Connection;
use std::sync::Arc;

fn scope() -> AgentTaskScope {
    AgentTaskScope {
        project: "/project".into(),
        principal: "alice".into(),
    }
}

#[test]
fn agent_metadata_is_owned_by_its_separate_store_and_reopens_without_application() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("studio.sqlite");
    let application = Arc::new(ApplicationStore::open(&path).unwrap());
    let owner = AgentTaskOwner::new(application.clone());
    let admitted = owner
        .admit(
            &scope(),
            &AgentTaskRequest {
                project_root: "/project".into(),
                window: AgentControllerRef {
                    window_id: "window".into(),
                    incarnation: "life".into(),
                },
                request_id: uuid::Uuid::new_v4().to_string(),
                command: AgentTaskCommand::Create {
                    provider: AgentProvider::Codex,
                    model: "fixture".into(),
                    effort: None,
                },
            },
            1,
        )
        .unwrap();
    let core = Connection::open(&path).unwrap();
    let tables: u32 = core.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND (name LIKE 'agent_%' OR name LIKE 'component_%')", [], |r| r.get(0)).unwrap();
    assert_eq!(tables, 0);
    drop(owner);
    drop(application);
    let agents =
        rho_agent_store::AgentStore::open(&path.with_extension("agent-v1.sqlite")).unwrap();
    let retained = agents
        .agent_task(&scope(), &admitted.task.task.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(retained.task.task_id, admitted.task.task.task_id);
    assert_eq!(retained.revision, admitted.task.revision);
    let hidden = AgentTaskScope {
        principal: "bob".into(),
        ..scope()
    };
    assert!(
        agents
            .agent_task(&hidden, &retained.task.task_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn preexisting_application_agent_named_data_is_neither_imported_nor_changed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("studio.sqlite");
    let core = Connection::open(&path).unwrap();
    // Uninterpreted foreign data is not a supported migration input.
    core.execute_batch(
        "CREATE TABLE agent_tasks(marker TEXT); INSERT INTO agent_tasks VALUES('preserved');",
    )
    .unwrap();
    let application = ApplicationStore::open(&path).unwrap();
    assert!(
        application
            .agent_tasks(&scope(), None, None, 10)
            .unwrap()
            .is_empty()
    );
    let marker: String = core
        .query_row("SELECT marker FROM agent_tasks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marker, "preserved");
    let count: u32 = core
        .query_row("SELECT COUNT(*) FROM agent_tasks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
