use lbug::{Connection, Database, SystemConfig};
use rho_evidence_graph::{
    ClaimDraft, ClaimListRequest, EvidenceGraph, GraphActorKind, GraphError, MAX_GRAPH_PAGE_SIZE,
    MAX_GRAPH_TRAVERSAL_DEPTH, MAX_NODE_LABEL_BYTES, SubgraphRequest,
};
use rho_protocol::{DataClass, ProjectId};

fn project(value: &str) -> ProjectId {
    ProjectId::new(value).unwrap()
}

fn draft(label: String) -> ClaimDraft {
    ClaimDraft {
        label,
        summary: "bounded summary".to_string(),
        claim_kind: "scientific_claim".to_string(),
        data_class: DataClass::ProjectInternal,
        actor: GraphActorKind::User,
    }
}

#[test]
fn bounds_fail_before_graph_mutation() {
    let root = tempfile::tempdir().unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project("project:a")).unwrap();
    assert!(matches!(
        graph.create_draft_claim(draft("x".repeat(MAX_NODE_LABEL_BYTES + 1))),
        Err(GraphError::LimitExceeded { .. })
    ));
    assert!(matches!(
        graph.list_claims(ClaimListRequest {
            cursor: None,
            limit: MAX_GRAPH_PAGE_SIZE + 1,
            include_drafts: true,
        }),
        Err(GraphError::LimitExceeded { .. })
    ));
    assert!(matches!(
        graph.get_subgraph(SubgraphRequest {
            root_node: "missing".to_string(),
            max_depth: MAX_GRAPH_TRAVERSAL_DEPTH + 1,
            max_nodes: 1,
        }),
        Err(GraphError::LimitExceeded { .. })
    ));
    assert_eq!(graph.graph_revision().unwrap(), 0);
}

#[test]
fn pagination_uses_stable_ordered_cursors() {
    let root = tempfile::tempdir().unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project("project:a")).unwrap();
    for label in ["one", "two", "three"] {
        graph.create_draft_claim(draft(label.to_string())).unwrap();
    }
    let first = graph
        .list_claims(ClaimListRequest {
            cursor: None,
            limit: 2,
            include_drafts: true,
        })
        .unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.has_more);
    let second = graph
        .list_claims(ClaimListRequest {
            cursor: first.next_cursor,
            limit: 2,
            include_drafts: true,
        })
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(!second.has_more);
}

#[test]
fn incompatible_or_interrupted_databases_are_rejected() {
    let partial_root = tempfile::tempdir().unwrap();
    std::fs::create_dir(partial_root.path().join(".rho")).unwrap();
    {
        let database = Database::new(
            partial_root.path().join(".rho/evidence.lbdb"),
            SystemConfig::default(),
        )
        .unwrap();
        let connection = Connection::new(&database).unwrap();
        connection
            .query("CREATE NODE TABLE Stray(id STRING PRIMARY KEY)")
            .unwrap();
    }
    assert!(matches!(
        EvidenceGraph::open(partial_root.path(), project("project:a")),
        Err(GraphError::Invariant(_)) | Err(GraphError::SchemaResetRequired { .. })
    ));

    let wrong_version_root = tempfile::tempdir().unwrap();
    drop(EvidenceGraph::open(wrong_version_root.path(), project("project:a")).unwrap());
    {
        let database = Database::new(
            wrong_version_root.path().join(".rho/evidence.lbdb"),
            SystemConfig::default(),
        )
        .unwrap();
        let connection = Connection::new(&database).unwrap();
        connection
            .query(
                "MATCH (metadata:GraphMetadata)
                 SET metadata.schema_version = 999",
            )
            .unwrap();
    }
    assert!(matches!(
        EvidenceGraph::open(wrong_version_root.path(), project("project:a")),
        Err(GraphError::SchemaResetRequired {
            found: Some(999),
            ..
        })
    ));
}

#[test]
fn corrupt_sidecar_is_reported_as_unavailable() {
    let root = tempfile::tempdir().unwrap();
    let graph = EvidenceGraph::open(root.path(), project("project:a")).unwrap();
    let database_path = graph.database_path().to_path_buf();
    drop(graph);
    std::fs::write(&database_path, b"not a Ladybug database").unwrap();
    assert!(matches!(
        EvidenceGraph::open(root.path(), project("project:a")),
        Err(GraphError::Ladybug(_))
    ));
}

#[cfg(unix)]
#[test]
fn symlinked_sidecar_root_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".rho")).unwrap();
    assert!(matches!(
        EvidenceGraph::open(root.path(), project("project:a")),
        Err(GraphError::UnsafePath(_))
    ));
}
