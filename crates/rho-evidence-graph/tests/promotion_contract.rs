use rho_evidence_graph::{
    ClaimDraft, EdgePredicate, EvidenceGraph, GapListRequest, GapRebuildRequest, GraphActorKind,
    GraphError, GraphRecordKind, LinkDraft, NodeKind, PromotionRequest, RetirementRequest,
};
use rho_protocol::{
    AUTHORITY_CONTRACT_VERSION, ArtifactReceiptV1, AuthorityDigest, AuthorityKindV1,
    AuthorityObservationV1, AuthorityReceiptBatchV1, AuthorityReceiptV1, AuthorityRefV1,
    AuthorityStatusV1, DataClass, EnvironmentReceiptV1, ProjectId, ProjectRevision,
    ProvenanceRefV1, RevisionRefV1, RunReceiptV1,
};

fn project() -> ProjectId {
    ProjectId::new("project:a").unwrap()
}

fn reference(kind: AuthorityKindV1, id: &str) -> AuthorityRefV1 {
    AuthorityRefV1::new(project(), kind, id).unwrap()
}

fn digest(byte: char) -> AuthorityDigest {
    AuthorityDigest::new(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
}

fn rebuild() -> GapRebuildRequest {
    GapRebuildRequest {
        authority_observations: Vec::new(),
        current_project_revision: None,
        current_state_revision: None,
        authority_head_cursor: None,
    }
}

#[test]
fn drafts_do_not_support_claims_and_only_admitted_promotions_become_formal() {
    let root = tempfile::tempdir().unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project()).unwrap();
    let run_ref = reference(AuthorityKindV1::Run, "run:1");
    let environment_ref = reference(AuthorityKindV1::EnvironmentSnapshot, "environment:1");
    let revision = RevisionRefV1 {
        reference: reference(AuthorityKindV1::Revision, "revision:1"),
        state_revision: None,
        project_revision: ProjectRevision(1),
    };
    graph
        .apply_authority_batch(&AuthorityReceiptBatchV1 {
            contract_version: AUTHORITY_CONTRACT_VERSION,
            feed_id: "feed".to_string(),
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
                    digest: digest('e'),
                    captured_at: "2026-08-31T20:00:01Z".to_string(),
                }),
                AuthorityReceiptV1::Artifact(ArtifactReceiptV1 {
                    reference: reference(AuthorityKindV1::Artifact, "artifact:1"),
                    digest: digest('a'),
                    byte_size: 10,
                    media_type: "text/plain".to_string(),
                    producing_run_ref: Some(run_ref.clone()),
                    revision,
                    captured_at: "2026-08-31T20:00:02Z".to_string(),
                }),
            ],
        })
        .unwrap();
    let run_node = graph
        .trace_artifact("artifact:1")
        .unwrap()
        .nodes
        .into_iter()
        .find(|node| node.kind == NodeKind::Run)
        .unwrap();
    let claim = graph
        .create_draft_claim(ClaimDraft {
            label: "Supported claim".to_string(),
            summary: "A claim".to_string(),
            claim_kind: "scientific_claim".to_string(),
            data_class: DataClass::ProjectInternal,
            actor: GraphActorKind::Agent,
        })
        .unwrap();

    assert!(matches!(
        graph.promote_draft(
            PromotionRequest {
                record_kind: GraphRecordKind::Node,
                record_id: claim.record_id.clone(),
                expected_graph_revision: 1,
                actor: GraphActorKind::User,
                policy_id: None,
            },
            &[],
        ),
        Err(GraphError::StaleRevision { .. })
    ));
    graph
        .promote_draft(
            PromotionRequest {
                record_kind: GraphRecordKind::Node,
                record_id: claim.record_id.clone(),
                expected_graph_revision: 2,
                actor: GraphActorKind::User,
                policy_id: None,
            },
            &[],
        )
        .unwrap();
    graph.rebuild_gaps(rebuild()).unwrap();
    assert_eq!(open_rules(&graph), vec!["unlinked_claim"]);

    let edge = graph
        .create_draft_link(LinkDraft {
            from_node: run_node.node_id,
            to_node: claim.record_id.clone(),
            predicate: EdgePredicate::Supports,
            provenance: Some(ProvenanceRefV1 {
                reference: run_ref.clone(),
                digest: None,
                project_revision: Some(ProjectRevision(1)),
                state_revision: None,
                captured_at: "2026-08-31T20:00:03Z".to_string(),
                bounded_excerpt: Some("bounded run result".to_string()),
                data_class: DataClass::ProjectInternal,
            }),
            confidence: Some(0.9),
            actor: GraphActorKind::Agent,
        })
        .unwrap();
    let unchanged = graph.rebuild_gaps(rebuild()).unwrap();
    assert_eq!(unchanged.changed_gaps, 0);
    assert_eq!(open_rules(&graph), vec!["unlinked_claim"]);

    let promotion = PromotionRequest {
        record_kind: GraphRecordKind::Edge,
        record_id: edge.record_id.clone(),
        expected_graph_revision: 5,
        actor: GraphActorKind::User,
        policy_id: None,
    };
    assert!(matches!(
        graph.promote_draft(promotion.clone(), &[]),
        Err(GraphError::UnresolvedAuthorityRef(_))
    ));
    assert!(matches!(
        graph.promote_draft(
            PromotionRequest {
                actor: GraphActorKind::Agent,
                ..promotion.clone()
            },
            &[],
        ),
        Err(GraphError::Admission(_))
    ));
    let observation = AuthorityObservationV1 {
        reference: run_ref.clone(),
        status: AuthorityStatusV1::Succeeded,
        digest: None,
        project_revision: Some(ProjectRevision(1)),
        state_revision: None,
        observed_at: "2026-08-31T20:00:04Z".to_string(),
        limitations: Vec::new(),
    };
    graph
        .promote_draft(promotion, std::slice::from_ref(&observation))
        .unwrap();
    let resolved = graph.rebuild_gaps(rebuild()).unwrap();
    assert_eq!(resolved.open_gaps, 0);
    assert!(open_rules(&graph).is_empty());
    let trace = graph.get_claim_trace(&claim.record_id).unwrap();
    assert!(trace.edges.iter().any(|value| {
        value.predicate == EdgePredicate::Supports
            && value.promotion_state == rho_evidence_graph::PromotionState::Promoted
    }));
    assert!(trace.authority_refs.contains(&run_ref));

    graph
        .retire_promoted_record(RetirementRequest {
            record_kind: GraphRecordKind::Edge,
            record_id: edge.record_id,
            expected_graph_revision: 7,
            actor: GraphActorKind::User,
        })
        .unwrap();
    graph.rebuild_gaps(rebuild()).unwrap();
    assert_eq!(open_rules(&graph), vec!["unlinked_claim"]);
}

fn open_rules(graph: &EvidenceGraph) -> Vec<String> {
    let mut rules = graph
        .list_gaps(GapListRequest {
            cursor: None,
            limit: 50,
            include_resolved: false,
        })
        .unwrap()
        .items
        .into_iter()
        .map(|gap| gap.rule_id)
        .collect::<Vec<_>>();
    rules.sort();
    rules
}
