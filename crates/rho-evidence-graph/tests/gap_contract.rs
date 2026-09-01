use std::collections::BTreeSet;

use rho_evidence_graph::{
    ClaimDraft, EdgePredicate, EvidenceGraph, GapListRequest, GapRebuildRequest, GraphActorKind,
    GraphRecordKind, LinkDraft, PromotionRequest,
};
use rho_protocol::{
    AUTHORITY_CONTRACT_VERSION, AgentTurnRefV1, ArtifactReceiptV1, AuthorityDigest,
    AuthorityKindV1, AuthorityObservationV1, AuthorityReceiptBatchV1, AuthorityReceiptV1,
    AuthorityRefV1, AuthorityStatusV1, DataClass, ProjectId, ProjectRevision, ProvenanceRefV1,
    RevisionRefV1, RunReceiptV1, SourceAnchorV1,
};

fn project() -> ProjectId {
    ProjectId::new("project:a").unwrap()
}

fn reference(kind: AuthorityKindV1, id: &str) -> AuthorityRefV1 {
    AuthorityRefV1::new(project(), kind, id).unwrap()
}

fn digest() -> AuthorityDigest {
    AuthorityDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap()
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
fn deterministic_gap_rebuild_opens_resolves_and_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project()).unwrap();
    let claim = graph
        .create_draft_claim(ClaimDraft {
            label: "Agent conclusion".to_string(),
            summary: "A conclusion requiring support".to_string(),
            claim_kind: "agent_conclusion".to_string(),
            data_class: DataClass::ProjectInternal,
            actor: GraphActorKind::Agent,
        })
        .unwrap();
    graph
        .promote_draft(
            PromotionRequest {
                record_kind: GraphRecordKind::Node,
                record_id: claim.record_id,
                expected_graph_revision: 1,
                actor: GraphActorKind::User,
                policy_id: None,
            },
            &[],
        )
        .unwrap();

    let first = graph.rebuild_gaps(rebuild()).unwrap();
    assert_eq!(first.changed_gaps, 2);
    assert_eq!(first.open_gaps, 2);
    assert_eq!(first.graph_revision, 3);
    assert_eq!(
        open_rules(&graph),
        BTreeSet::from([
            "unlinked_claim".to_string(),
            "unverified_agent_conclusion".to_string(),
        ])
    );

    let revision = RevisionRefV1 {
        reference: reference(AuthorityKindV1::Revision, "revision:1"),
        state_revision: None,
        project_revision: ProjectRevision(1),
    };
    graph
        .apply_authority_batch(&AuthorityReceiptBatchV1 {
            contract_version: AUTHORITY_CONTRACT_VERSION,
            feed_id: "authority-feed".to_string(),
            after_cursor: 0,
            next_cursor: 2,
            has_more: false,
            receipts: vec![
                AuthorityReceiptV1::Run(RunReceiptV1 {
                    reference: reference(AuthorityKindV1::Run, "run:missing-environment"),
                    status: AuthorityStatusV1::Succeeded,
                    revision_before: None,
                    revision_after: Some(revision.clone()),
                    environment_ref: None,
                    source_anchor_ref: None,
                    captured_at: "2026-08-31T20:00:00Z".to_string(),
                }),
                AuthorityReceiptV1::Artifact(ArtifactReceiptV1 {
                    reference: reference(AuthorityKindV1::Artifact, "artifact:orphan"),
                    digest: digest(),
                    byte_size: 1,
                    media_type: "text/plain".to_string(),
                    producing_run_ref: None,
                    revision,
                    captured_at: "2026-08-31T20:00:01Z".to_string(),
                }),
            ],
        })
        .unwrap();
    let second = graph.rebuild_gaps(rebuild()).unwrap();
    assert_eq!(second.changed_gaps, 2);
    assert_eq!(second.open_gaps, 4);
    assert_eq!(
        open_rules(&graph),
        BTreeSet::from([
            "missing_environment".to_string(),
            "missing_run_provenance".to_string(),
            "unlinked_claim".to_string(),
            "unverified_agent_conclusion".to_string(),
        ])
    );

    let unchanged = graph.rebuild_gaps(rebuild()).unwrap();
    assert_eq!(unchanged.changed_gaps, 0);
    assert_eq!(unchanged.graph_revision, second.graph_revision);
}

#[test]
fn live_authority_and_graph_state_drive_stale_conflict_and_lag_gaps() {
    let root = tempfile::tempdir().unwrap();
    let mut graph = EvidenceGraph::open(root.path(), project()).unwrap();
    let source_ref = reference(AuthorityKindV1::SourceAnchor, "source:1");
    let turn_ref = reference(AuthorityKindV1::AgentTurn, "turn:1");
    graph
        .apply_authority_batch(&AuthorityReceiptBatchV1 {
            contract_version: AUTHORITY_CONTRACT_VERSION,
            feed_id: "authority-feed".to_string(),
            after_cursor: 0,
            next_cursor: 2,
            has_more: false,
            receipts: vec![
                AuthorityReceiptV1::SourceAnchor(SourceAnchorV1 {
                    reference: source_ref.clone(),
                    path: "analysis/model.R".to_string(),
                    start_line: 1,
                    start_column: Some(1),
                    end_line: 2,
                    end_column: Some(20),
                    content_digest: digest(),
                    bounded_excerpt: "fit <- lm(y ~ x)".to_string(),
                    project_revision: ProjectRevision(1),
                    captured_at: "2026-08-31T20:00:00Z".to_string(),
                }),
                AuthorityReceiptV1::AgentTurn(AgentTurnRefV1 {
                    reference: turn_ref.clone(),
                    status: AuthorityStatusV1::Succeeded,
                    captured_at: "2026-08-31T20:00:01Z".to_string(),
                }),
            ],
        })
        .unwrap();
    let source_node = graph.get_authority_node(&source_ref).unwrap();
    let claim = graph
        .create_draft_claim(ClaimDraft {
            label: "Model claim".to_string(),
            summary: "The fitted model supports the effect".to_string(),
            claim_kind: "scientific_claim".to_string(),
            data_class: DataClass::ProjectInternal,
            actor: GraphActorKind::User,
        })
        .unwrap();
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
    let fresh_source = AuthorityObservationV1 {
        reference: source_ref.clone(),
        status: AuthorityStatusV1::Present,
        digest: Some(digest()),
        project_revision: Some(ProjectRevision(1)),
        state_revision: None,
        observed_at: "2026-08-31T20:00:02Z".to_string(),
        limitations: Vec::new(),
    };
    for predicate in [EdgePredicate::Supports, EdgePredicate::Contradicts] {
        let edge = graph
            .create_draft_link(LinkDraft {
                from_node: source_node.node_id.clone(),
                to_node: claim.record_id.clone(),
                predicate,
                provenance: Some(ProvenanceRefV1 {
                    reference: source_ref.clone(),
                    digest: Some(digest()),
                    project_revision: Some(ProjectRevision(1)),
                    state_revision: None,
                    captured_at: "2026-08-31T20:00:02Z".to_string(),
                    bounded_excerpt: Some("fit <- lm(y ~ x)".to_string()),
                    data_class: DataClass::ProjectInternal,
                }),
                confidence: None,
                actor: GraphActorKind::User,
            })
            .unwrap();
        graph
            .promote_draft(
                PromotionRequest {
                    record_kind: GraphRecordKind::Edge,
                    record_id: edge.record_id,
                    expected_graph_revision: edge.graph_revision,
                    actor: GraphActorKind::User,
                    policy_id: None,
                },
                std::slice::from_ref(&fresh_source),
            )
            .unwrap();
    }

    let stale = AuthorityObservationV1 {
        status: AuthorityStatusV1::Stale,
        digest: Some(AuthorityDigest::new(format!("sha256:{}", "b".repeat(64))).unwrap()),
        project_revision: Some(ProjectRevision(2)),
        observed_at: "2026-08-31T20:00:03Z".to_string(),
        ..fresh_source.clone()
    };
    let missing_turn = AuthorityObservationV1 {
        reference: turn_ref.clone(),
        status: AuthorityStatusV1::Missing,
        digest: None,
        project_revision: Some(ProjectRevision(2)),
        state_revision: None,
        observed_at: "2026-08-31T20:00:03Z".to_string(),
        limitations: Vec::new(),
    };
    let outcome = graph
        .rebuild_gaps(GapRebuildRequest {
            authority_observations: vec![stale, missing_turn],
            current_project_revision: Some(2),
            current_state_revision: None,
            authority_head_cursor: Some(3),
        })
        .unwrap();
    assert_eq!(outcome.open_gaps, 5);
    assert_eq!(
        open_rules(&graph),
        BTreeSet::from([
            "conflicting_evidence".to_string(),
            "needs_reobserve".to_string(),
            "sidecar_ingest_lag".to_string(),
            "stale_source_anchor".to_string(),
            "unresolved_authority_ref".to_string(),
        ])
    );

    let present_turn = AuthorityObservationV1 {
        status: AuthorityStatusV1::Present,
        ..AuthorityObservationV1 {
            reference: turn_ref,
            status: AuthorityStatusV1::Missing,
            digest: None,
            project_revision: Some(ProjectRevision(1)),
            state_revision: None,
            observed_at: "2026-08-31T20:00:04Z".to_string(),
            limitations: Vec::new(),
        }
    };
    let resolved = graph
        .rebuild_gaps(GapRebuildRequest {
            authority_observations: vec![fresh_source, present_turn],
            current_project_revision: Some(1),
            current_state_revision: None,
            authority_head_cursor: Some(2),
        })
        .unwrap();
    assert_eq!(resolved.open_gaps, 1);
    assert_eq!(
        open_rules(&graph),
        BTreeSet::from(["conflicting_evidence".to_string()])
    );
}

fn open_rules(graph: &EvidenceGraph) -> BTreeSet<String> {
    graph
        .list_gaps(GapListRequest {
            cursor: None,
            limit: 50,
            include_resolved: false,
        })
        .unwrap()
        .items
        .into_iter()
        .map(|gap| gap.rule_id)
        .collect()
}
