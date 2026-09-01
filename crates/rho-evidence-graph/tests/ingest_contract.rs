use rho_evidence_graph::{EvidenceGraph, GraphError};
use rho_protocol::{
    AUTHORITY_CONTRACT_VERSION, AgentTurnRefV1, ArtifactReceiptV1, AuthorityDigest,
    AuthorityKindV1, AuthorityReceiptBatchV1, AuthorityReceiptV1, AuthorityRefV1,
    AuthorityStatusV1, EnvironmentReceiptV1, ProjectId, ProjectRevision, RevisionRefV1,
    RunReceiptV1,
};

fn project(value: &str) -> ProjectId {
    ProjectId::new(value).unwrap()
}

fn reference(project_id: &ProjectId, kind: AuthorityKindV1, id: &str) -> AuthorityRefV1 {
    AuthorityRefV1::new(project_id.clone(), kind, id).unwrap()
}

fn digest(byte: char) -> AuthorityDigest {
    AuthorityDigest::new(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
}

#[test]
fn authority_ingest_is_atomic_idempotent_and_traversable() {
    let root = tempfile::tempdir().unwrap();
    let project_id = project("project:a");
    let mut graph = EvidenceGraph::open(root.path(), project_id.clone()).unwrap();
    let run_ref = reference(&project_id, AuthorityKindV1::Run, "run:1");
    let environment_ref = reference(
        &project_id,
        AuthorityKindV1::EnvironmentSnapshot,
        "environment:1",
    );
    let revision = RevisionRefV1 {
        reference: reference(&project_id, AuthorityKindV1::Revision, "revision:1"),
        state_revision: None,
        project_revision: ProjectRevision(1),
    };
    let batch = AuthorityReceiptBatchV1 {
        contract_version: AUTHORITY_CONTRACT_VERSION,
        feed_id: "authority-feed".to_string(),
        after_cursor: 0,
        next_cursor: 3,
        has_more: false,
        receipts: vec![
            AuthorityReceiptV1::Run(RunReceiptV1 {
                reference: run_ref.clone(),
                status: AuthorityStatusV1::Succeeded,
                revision_before: None,
                revision_after: Some(revision.clone()),
                environment_ref: Some(environment_ref.clone()),
                source_anchor_ref: None,
                captured_at: "2026-08-31T20:00:00Z".to_string(),
            }),
            AuthorityReceiptV1::Environment(EnvironmentReceiptV1 {
                reference: environment_ref,
                digest: digest('b'),
                captured_at: "2026-08-31T20:00:01Z".to_string(),
            }),
            AuthorityReceiptV1::Artifact(ArtifactReceiptV1 {
                reference: reference(&project_id, AuthorityKindV1::Artifact, "artifact:1"),
                digest: digest('a'),
                byte_size: 42,
                media_type: "image/png".to_string(),
                producing_run_ref: Some(run_ref),
                revision,
                captured_at: "2026-08-31T20:00:02Z".to_string(),
            }),
        ],
    };

    let applied = graph.apply_authority_batch(&batch).unwrap();
    assert_eq!(applied.applied_receipts, 3);
    assert_eq!(applied.graph_revision, 1);
    assert_eq!(applied.authority_cursor, 3);
    let health = graph.health().unwrap();
    assert_eq!(health.authority_cursor, 3);
    assert!(health.last_ingest_success_at.is_some());
    assert!(health.last_ingest_error_code.is_none());

    let trace = graph.trace_artifact("artifact:1").unwrap();
    assert_eq!(trace.nodes.len(), 3);
    assert_eq!(trace.edges.len(), 2);

    let replayed = graph.apply_authority_batch(&batch).unwrap();
    assert_eq!(replayed.applied_receipts, 0);
    assert_eq!(replayed.graph_revision, 1);
    assert_eq!(graph.trace_artifact("artifact:1").unwrap().nodes.len(), 3);

    let stale = AuthorityReceiptBatchV1 {
        after_cursor: 2,
        next_cursor: 4,
        receipts: vec![AuthorityReceiptV1::AgentTurn(AgentTurnRefV1 {
            reference: reference(&project_id, AuthorityKindV1::AgentTurn, "turn:1"),
            status: AuthorityStatusV1::Succeeded,
            captured_at: "2026-08-31T20:00:03Z".to_string(),
        })],
        ..batch
    };
    assert!(matches!(
        graph.apply_authority_batch(&stale),
        Err(GraphError::StaleAuthorityCursor { .. })
    ));
    assert_eq!(graph.graph_revision().unwrap(), 1);
}

#[test]
fn ingest_error_is_graph_health_only() {
    let root = tempfile::tempdir().unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project("project:a")).unwrap();
    graph
        .record_ingest_error("authority-feed", "AUTHORITY_UNAVAILABLE")
        .unwrap();
    let health = graph.health().unwrap();
    assert_eq!(health.authority_cursor, 0);
    assert_eq!(
        health.last_ingest_error_code.as_deref(),
        Some("AUTHORITY_UNAVAILABLE")
    );
}
