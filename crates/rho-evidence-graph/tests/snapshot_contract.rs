use rho_evidence_graph::{ClaimDraft, EvidenceGraph, GraphActorKind};
use rho_protocol::{DataClass, ProjectId};

fn claim(label: &str) -> ClaimDraft {
    ClaimDraft {
        label: label.to_string(),
        summary: label.to_string(),
        claim_kind: "scientific_claim".to_string(),
        data_class: DataClass::ProjectInternal,
        actor: GraphActorKind::User,
    }
}

#[test]
fn snapshots_digest_canonical_graph_content_and_track_event_ranges() {
    let root = tempfile::tempdir().unwrap();
    let project_id = ProjectId::new("project:a").unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project_id.clone()).unwrap();
    graph.create_draft_claim(claim("First")).unwrap();

    let first = graph.snapshot_graph().unwrap();
    assert_eq!((first.event_start, first.event_end), (1, 2));
    let second = graph.snapshot_graph().unwrap();
    assert_eq!((second.event_start, second.event_end), (3, 3));
    assert_eq!(first.graph_digest, second.graph_digest);

    graph.create_draft_claim(claim("Second")).unwrap();
    let third = graph.snapshot_graph().unwrap();
    assert_eq!((third.event_start, third.event_end), (4, 5));
    assert_ne!(second.graph_digest, third.graph_digest);
    drop(graph);

    let graph = EvidenceGraph::open(root.path(), project_id).unwrap();
    assert_eq!(graph.graph_revision().unwrap(), 5);
}
