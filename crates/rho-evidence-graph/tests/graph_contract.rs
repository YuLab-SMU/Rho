use rho_evidence_graph::{
    ClaimDraft, ClaimListRequest, EdgePredicate, EvidenceGraph, GraphActorKind, GraphError,
    LinkDraft, SubgraphRequest,
};
use rho_protocol::{DataClass, ProjectId};

fn project(value: &str) -> ProjectId {
    ProjectId::new(value).unwrap()
}

fn claim(label: &str) -> ClaimDraft {
    ClaimDraft {
        label: label.to_string(),
        summary: format!("Summary for {label}"),
        claim_kind: "scientific_claim".to_string(),
        data_class: DataClass::ProjectInternal,
        actor: GraphActorKind::User,
    }
}

#[test]
fn project_graph_opens_mutates_traverses_and_reopens() {
    let root = tempfile::tempdir().unwrap();
    let first_id;
    {
        let mut graph = EvidenceGraph::open(root.path(), project("project:a")).unwrap();
        assert_eq!(graph.health().unwrap().graph_revision, 0);
        let first = graph.create_draft_claim(claim("First claim")).unwrap();
        let second = graph.create_draft_claim(claim("Second claim")).unwrap();
        first_id = first.record_id.clone();
        let link = graph
            .create_draft_link(LinkDraft {
                from_node: first.record_id.clone(),
                to_node: second.record_id.clone(),
                predicate: EdgePredicate::DerivedFrom,
                provenance: None,
                confidence: None,
                actor: GraphActorKind::User,
            })
            .unwrap();
        assert_eq!(link.graph_revision, 3);

        let claims = graph
            .list_claims(ClaimListRequest {
                cursor: None,
                limit: 20,
                include_drafts: true,
            })
            .unwrap();
        assert_eq!(claims.items.len(), 2);
        let subgraph = graph
            .get_subgraph(SubgraphRequest {
                root_node: first.record_id,
                max_depth: 2,
                max_nodes: 20,
            })
            .unwrap();
        assert_eq!(subgraph.nodes.len(), 2);
        assert_eq!(subgraph.edges.len(), 1);
        assert!(!subgraph.truncated);
    }

    {
        let graph = EvidenceGraph::open(root.path(), project("project:a")).unwrap();
        assert_eq!(graph.health().unwrap().graph_revision, 3);
        assert_eq!(graph.get_node(&first_id).unwrap().label, "First claim");
    }

    assert!(matches!(
        EvidenceGraph::open(root.path(), project("project:b")),
        Err(GraphError::DatabaseProjectMismatch)
    ));
}

#[test]
fn graph_rejects_restricted_secret_claims_without_mutation() {
    let root = tempfile::tempdir().unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project("project:a")).unwrap();
    let mut draft = claim("Secret claim");
    draft.data_class = DataClass::RestrictedSecret;
    assert!(matches!(
        graph.create_draft_claim(draft),
        Err(GraphError::Admission(_))
    ));
    assert_eq!(graph.graph_revision().unwrap(), 0);
}
