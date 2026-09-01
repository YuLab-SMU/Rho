use rho_evidence_graph::{ClaimDraft, GraphActorKind, GraphError, ProjectGraphManager};
use rho_protocol::{DataClass, ProjectId};

fn project(value: &str) -> ProjectId {
    ProjectId::new(value).unwrap()
}

#[test]
fn manager_never_reuses_a_graph_across_project_switches() {
    let root_a = tempfile::tempdir().unwrap();
    let root_b = tempfile::tempdir().unwrap();
    let manager = ProjectGraphManager::default();
    assert!(
        manager
            .activate(root_a.path(), project("project:a"))
            .available
    );
    manager
        .with_graph_mut(root_a.path(), &project("project:a"), |graph| {
            graph.create_draft_claim(ClaimDraft {
                label: "Project A claim".to_string(),
                summary: "A".to_string(),
                claim_kind: "scientific_claim".to_string(),
                data_class: DataClass::ProjectInternal,
                actor: GraphActorKind::User,
            })?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        manager
            .with_graph(root_a.path(), &project("project:a"), |graph| {
                graph.graph_revision()
            })
            .unwrap(),
        1
    );

    assert!(
        manager
            .activate(root_b.path(), project("project:b"))
            .available
    );
    assert!(matches!(
        manager.with_graph(root_a.path(), &project("project:a"), |_| Ok(())),
        Err(GraphError::ProjectMismatch)
    ));
    assert_eq!(
        manager
            .with_graph(root_b.path(), &project("project:b"), |graph| {
                graph.graph_revision()
            })
            .unwrap(),
        0
    );
}

#[test]
fn unavailable_graph_is_health_state_not_activation_failure() {
    let root = tempfile::tempdir().unwrap();
    let graph = rho_evidence_graph::EvidenceGraph::open(root.path(), project("project:a")).unwrap();
    let database = graph.database_path().to_path_buf();
    drop(graph);
    std::fs::write(database, b"corrupt").unwrap();

    let manager = ProjectGraphManager::default();
    let health = manager.activate(root.path(), project("project:a"));
    assert!(!health.available);
    assert_eq!(
        health.error_code.as_deref(),
        Some("GRAPH_ENGINE_UNAVAILABLE")
    );
    assert!(matches!(
        manager.with_graph(root.path(), &project("project:a"), |_| Ok(())),
        Err(GraphError::Unavailable { .. })
    ));
}
