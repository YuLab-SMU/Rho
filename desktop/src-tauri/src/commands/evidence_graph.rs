use chrono::Utc;
use rho_evidence_graph::{
    ClaimDraft, ClaimListRequest, ClaimRevision, GapListRequest, GapRebuildRequest, GraphActorKind,
    GraphMutationResult, LinkDraft, PromotionRequest, RetirementRequest, SubgraphRequest,
};
use rho_protocol::{AuthorityDigest, DataClass, ProjectRevision, ProvenanceRefV1, StateRevision};
use rho_ui_contract::{
    ClaimListRequestV1, ClaimPageV1, ClaimTraceViewV1, CreateDraftClaimRequestV1,
    CreateDraftLinkRequestV1, EVIDENCE_GRAPH_VIEW_CONTRACT, EvidenceGapListRequestV1,
    EvidenceGapPageV1, EvidenceGraphHealthViewV1, EvidenceMutationViewV1, EvidenceNodeId,
    EvidencePromotionRequestV1, EvidenceRetirementRequestV1, EvidenceSubgraphRequestV1,
    EvidenceSubgraphViewV1, ReviseDraftClaimRequestV1, Validate,
};
use tauri::State;

use crate::application_state::{active_context, store_executor};
use crate::evidence_graph_runtime::{
    active_graph_context, convert_enum, graph_health_view, project_claim_trace, project_gap,
    project_node, project_subgraph, protocol_authority_ref, require_available,
    resolve_authority_observations, ui_project_id,
};
use crate::{AppState, display_error};

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_graph_health(
    state: State<'_, AppState>,
) -> Result<EvidenceGraphHealthViewV1, String> {
    let context = active_graph_context(&state).await.map_err(display_error)?;
    graph_health_view(&context).map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_list_claims(
    request: ClaimListRequestV1,
    state: State<'_, AppState>,
) -> Result<ClaimPageV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            let page = graph.list_claims(ClaimListRequest {
                cursor: request.cursor.clone(),
                limit: request.limit,
                include_drafts: request.include_drafts,
            })?;
            Ok(ClaimPageV1 {
                contract: EVIDENCE_GRAPH_VIEW_CONTRACT.to_string(),
                project_id: ui_project_id(graph.project_id()).map_err(|error| {
                    rho_evidence_graph::GraphError::Invariant(error.to_string())
                })?,
                items: page
                    .items
                    .into_iter()
                    .map(|node| {
                        project_node(graph, node).map_err(|error| {
                            rho_evidence_graph::GraphError::Invariant(error.to_string())
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                next_cursor: page.next_cursor,
                has_more: page.has_more,
            })
        })
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_get_claim_trace(
    claim_id: EvidenceNodeId,
    state: State<'_, AppState>,
) -> Result<ClaimTraceViewV1, String> {
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            let trace = graph.get_claim_trace(claim_id.as_str())?;
            project_claim_trace(graph, trace)
                .map_err(|error| rho_evidence_graph::GraphError::Invariant(error.to_string()))
        })
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_get_subgraph(
    request: EvidenceSubgraphRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceSubgraphViewV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            let subgraph = graph.get_subgraph(SubgraphRequest {
                root_node: request.root_node.as_str().to_string(),
                max_depth: request.max_depth,
                max_nodes: request.max_nodes,
            })?;
            project_subgraph(graph, subgraph)
                .map_err(|error| rho_evidence_graph::GraphError::Invariant(error.to_string()))
        })
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_list_gaps(
    request: EvidenceGapListRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceGapPageV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            let page = graph.list_gaps(GapListRequest {
                cursor: request.cursor.clone(),
                limit: request.limit,
                include_resolved: request.include_resolved,
            })?;
            Ok(EvidenceGapPageV1 {
                contract: EVIDENCE_GRAPH_VIEW_CONTRACT.to_string(),
                project_id: ui_project_id(graph.project_id()).map_err(|error| {
                    rho_evidence_graph::GraphError::Invariant(error.to_string())
                })?,
                items: page
                    .items
                    .into_iter()
                    .map(|gap| {
                        project_gap(gap).map_err(|error| {
                            rho_evidence_graph::GraphError::Invariant(error.to_string())
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                next_cursor: page.next_cursor,
                has_more: page.has_more,
            })
        })
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_trace_artifact(
    artifact_id: String,
    state: State<'_, AppState>,
) -> Result<EvidenceSubgraphViewV1, String> {
    bounded_id(&artifact_id, "artifact_id").map_err(display_error)?;
    refresh_evidence_graph_for_state(&state).await?;
    evidence_authority_subgraph(&state, |graph| graph.trace_artifact(&artifact_id)).await
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_list_agent_turn(
    turn_id: String,
    state: State<'_, AppState>,
) -> Result<EvidenceSubgraphViewV1, String> {
    bounded_id(&turn_id, "turn_id").map_err(display_error)?;
    refresh_evidence_graph_for_state(&state).await?;
    evidence_authority_subgraph(&state, |graph| graph.list_agent_turn_evidence(&turn_id)).await
}

async fn evidence_authority_subgraph(
    state: &AppState,
    operation: impl FnOnce(
        &rho_evidence_graph::EvidenceGraph,
    ) -> Result<
        rho_evidence_graph::EvidenceSubgraph,
        rho_evidence_graph::GraphError,
    >,
) -> Result<EvidenceSubgraphViewV1, String> {
    let context = active_graph_context(state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            project_subgraph(graph, operation(graph)?)
                .map_err(|error| rho_evidence_graph::GraphError::Invariant(error.to_string()))
        })
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_create_draft_claim(
    request: CreateDraftClaimRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceMutationViewV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    let data_class = convert_enum::<_, DataClass>(request.data_class).map_err(display_error)?;
    mutate(&state, &context, |graph| {
        graph.create_draft_claim(ClaimDraft {
            label: request.label,
            summary: request.summary,
            claim_kind: request.claim_kind,
            data_class,
            actor: GraphActorKind::User,
        })
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_revise_draft_claim(
    request: ReviseDraftClaimRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceMutationViewV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    mutate(&state, &context, |graph| {
        graph.revise_draft_claim(ClaimRevision {
            claim_id: request.claim_id.as_str().to_string(),
            expected_graph_revision: request.expected_graph_revision,
            label: request.label,
            summary: request.summary,
            claim_kind: request.claim_kind,
            actor: GraphActorKind::User,
        })
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_create_draft_link(
    request: CreateDraftLinkRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceMutationViewV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    let predicate = convert_enum(request.predicate).map_err(display_error)?;
    let provenance = request
        .provenance
        .map(|value| {
            Ok::<_, anyhow::Error>(ProvenanceRefV1 {
                reference: protocol_authority_ref(&context.project_id, &value.reference)?,
                digest: value.digest.map(AuthorityDigest::new).transpose()?,
                project_revision: value.project_revision.map(ProjectRevision),
                state_revision: value.state_revision.map(StateRevision),
                captured_at: Utc::now().to_rfc3339(),
                bounded_excerpt: value.bounded_excerpt,
                data_class: convert_enum(value.data_class)?,
            })
        })
        .transpose()
        .map_err(display_error)?;
    mutate(&state, &context, |graph| {
        graph.create_draft_link(LinkDraft {
            from_node: request.from_node.as_str().to_string(),
            to_node: request.to_node.as_str().to_string(),
            predicate,
            provenance,
            confidence: request.confidence,
            actor: GraphActorKind::User,
        })
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_retire_draft(
    request: EvidenceRetirementRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceMutationViewV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    let record_kind = convert_enum(request.record_kind).map_err(display_error)?;
    mutate(&state, &context, |graph| {
        graph.retire_draft(RetirementRequest {
            record_kind,
            record_id: request.record_id,
            expected_graph_revision: request.expected_graph_revision,
            actor: GraphActorKind::User,
        })
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_promote_draft(
    request: EvidencePromotionRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceMutationViewV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    let record_kind = convert_enum(request.record_kind).map_err(display_error)?;
    let references = state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            graph.promotion_authority_refs(record_kind, &request.record_id)
        })
        .map_err(display_error)?;
    let observations = resolve_authority_observations(&state, &context, &references)
        .await
        .map_err(display_error)?;
    mutate(&state, &context, |graph| {
        graph.promote_draft(
            PromotionRequest {
                record_kind,
                record_id: request.record_id,
                expected_graph_revision: request.expected_graph_revision,
                actor: GraphActorKind::User,
                policy_id: None,
            },
            &observations,
        )
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_retire_promoted(
    request: EvidenceRetirementRequestV1,
    state: State<'_, AppState>,
) -> Result<EvidenceMutationViewV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    let record_kind = convert_enum(request.record_kind).map_err(display_error)?;
    mutate(&state, &context, |graph| {
        graph.retire_promoted_record(RetirementRequest {
            record_kind,
            record_id: request.record_id,
            expected_graph_revision: request.expected_graph_revision,
            actor: GraphActorKind::User,
        })
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_refresh(
    state: State<'_, AppState>,
) -> Result<EvidenceGraphHealthViewV1, String> {
    refresh_evidence_graph_for_state(&state).await
}

pub(crate) async fn refresh_evidence_graph_for_state(
    state: &AppState,
) -> Result<EvidenceGraphHealthViewV1, String> {
    let context = active_graph_context(state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    let project_root = rho_store::normalize_project_root(context.root.to_string_lossy().as_ref());
    let feed = store_executor(state)
        .await
        .map_err(display_error)?
        .authority_feed();
    let mut cursor = context
        .health
        .graph
        .as_ref()
        .map_or(0, |health| health.authority_cursor);
    let mut feed_complete = false;
    for _ in 0..20 {
        let batch = feed
            .receipt_batch(
                project_root.clone(),
                context.project_id.clone(),
                cursor,
                rho_protocol::MAX_RECEIPT_BATCH_ITEMS,
            )
            .await
            .map_err(display_error)?;
        cursor = batch.next_cursor;
        state
            .evidence_graph
            .with_graph_mut(&context.root, &context.project_id, |graph| {
                graph.apply_authority_batch(&batch).map(|_| ())
            })
            .map_err(display_error)?;
        if !batch.has_more {
            feed_complete = true;
            break;
        }
    }
    if !feed_complete {
        state
            .evidence_graph
            .with_graph_mut(&context.root, &context.project_id, |graph| {
                graph
                    .record_ingest_error("rho-store-authority-v1", "FEED_BATCH_LIMIT")
                    .map(|_| ())
            })
            .map_err(display_error)?;
    }
    let references = state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            graph.all_authority_refs()
        })
        .map_err(display_error)?;
    let observations = resolve_authority_observations(state, &context, &references)
        .await
        .map_err(display_error)?;
    let revisions = match active_context(state).await {
        Ok(workspace) => {
            let identity = workspace.identity();
            (
                Some(identity.project_revision),
                Some(identity.state_revision),
            )
        }
        Err(_) => (None, None),
    };
    state
        .evidence_graph
        .with_graph_mut(&context.root, &context.project_id, |graph| {
            graph.reconcile_authority_refs(&observations)?;
            graph.rebuild_gaps(GapRebuildRequest {
                authority_observations: observations,
                current_project_revision: revisions.0,
                current_state_revision: revisions.1,
                authority_head_cursor: None,
            })?;
            Ok(())
        })
        .map_err(display_error)?;
    let refreshed = active_graph_context(state).await.map_err(display_error)?;
    graph_health_view(&refreshed).map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn evidence_snapshot(
    state: State<'_, AppState>,
) -> Result<EvidenceMutationViewV1, String> {
    let context = active_graph_context(&state).await.map_err(display_error)?;
    require_available(&context).map_err(display_error)?;
    mutate(&state, &context, |graph| {
        let snapshot = graph.snapshot_graph()?;
        Ok(GraphMutationResult {
            record_id: snapshot.snapshot_id,
            graph_revision: snapshot.event_end,
        })
    })
}

fn mutate(
    state: &AppState,
    context: &crate::evidence_graph_runtime::ActiveGraphContext,
    operation: impl FnOnce(
        &mut rho_evidence_graph::EvidenceGraph,
    ) -> Result<GraphMutationResult, rho_evidence_graph::GraphError>,
) -> Result<EvidenceMutationViewV1, String> {
    state
        .evidence_graph
        .with_graph_mut(&context.root, &context.project_id, operation)
        .map(|result| EvidenceMutationViewV1 {
            record_id: result.record_id,
            graph_revision: result.graph_revision,
        })
        .map_err(display_error)
}

fn bounded_id(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(anyhow::anyhow!("{field} is invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn evidence_graph_typescript_export() {
        let output_path = std::env::var_os("RHO_EVIDENCE_GRAPH_BINDINGS_PATH")
            .expect("RHO_EVIDENCE_GRAPH_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                super::evidence_graph_health,
                super::evidence_list_claims,
                super::evidence_get_claim_trace,
                super::evidence_get_subgraph,
                super::evidence_list_gaps,
                super::evidence_trace_artifact,
                super::evidence_list_agent_turn,
                super::evidence_create_draft_claim,
                super::evidence_revise_draft_claim,
                super::evidence_create_draft_link,
                super::evidence_retire_draft,
                super::evidence_promote_draft,
                super::evidence_retire_promoted,
                super::evidence_refresh,
                super::evidence_snapshot,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Evidence Graph TypeScript export must succeed");
    }
}
