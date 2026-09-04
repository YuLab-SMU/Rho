use rho_protocol::{AuthorityReceiptV1, AuthorityStatusV1};
use rho_ui_contract::{
    AuthorityReceiptListRequestV1, AuthorityReceiptPageV1, AuthorityReceiptSummaryV1,
    AuthorityResolveRequestV1, AuthorityResolveResponseV1, Validate,
};
use tauri::State;

use crate::application_state::store_executor;
use crate::evidence_graph_runtime::{
    active_graph_context, authority_observation_view, authority_reference_view, convert_enum,
    protocol_authority_ref, resolve_authority_observations, ui_project_id,
};
use crate::{AppState, display_error};

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn authority_resolve_refs(
    request: AuthorityResolveRequestV1,
    state: State<'_, AppState>,
) -> Result<AuthorityResolveResponseV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    let references = request
        .references
        .iter()
        .map(|reference| protocol_authority_ref(&context.project_id, reference))
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(display_error)?;
    let observations = resolve_authority_observations(&state, &context, &references)
        .await
        .map_err(display_error)?;
    Ok(AuthorityResolveResponseV1 {
        project_id: ui_project_id(&context.project_id).map_err(display_error)?,
        observations: observations
            .into_iter()
            .map(authority_observation_view)
            .collect::<anyhow::Result<Vec<_>>>()
            .map_err(display_error)?,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn authority_list_receipts(
    request: AuthorityReceiptListRequestV1,
    state: State<'_, AppState>,
) -> Result<AuthorityReceiptPageV1, String> {
    request.validate().map_err(display_error)?;
    let context = active_graph_context(&state).await.map_err(display_error)?;
    let requested_kind = convert_enum(request.kind).map_err(display_error)?;
    let project_root = rho_store::normalize_project_root(context.root.to_string_lossy().as_ref());
    let batch = store_executor(&state)
        .await
        .map_err(display_error)?
        .authority_feed()
        .receipt_batch(
            project_root,
            context.project_id.clone(),
            request.cursor.unwrap_or(0),
            rho_protocol::MAX_RECEIPT_BATCH_ITEMS,
        )
        .await
        .map_err(display_error)?;
    let mut summaries = batch
        .receipts
        .into_iter()
        .filter(|receipt| receipt.reference().kind == requested_kind)
        .map(authority_receipt_summary)
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(display_error)?;
    let truncated = summaries.len() > request.limit;
    summaries.truncate(request.limit);
    Ok(AuthorityReceiptPageV1 {
        project_id: ui_project_id(&context.project_id).map_err(display_error)?,
        items: summaries,
        next_cursor: batch.next_cursor,
        has_more: batch.has_more || truncated,
    })
}

fn authority_receipt_summary(
    receipt: AuthorityReceiptV1,
) -> anyhow::Result<AuthorityReceiptSummaryV1> {
    let (status, label, digest, captured_at, related) = match &receipt {
        AuthorityReceiptV1::Run(value) => (
            value.status,
            value.reference.authority_id.clone(),
            None,
            value.captured_at.clone(),
            value
                .environment_ref
                .iter()
                .chain(value.source_anchor_ref.iter())
                .cloned()
                .collect(),
        ),
        AuthorityReceiptV1::Artifact(value) => (
            AuthorityStatusV1::Present,
            value.reference.authority_id.clone(),
            Some(value.digest.to_string()),
            value.captured_at.clone(),
            value.producing_run_ref.iter().cloned().collect(),
        ),
        AuthorityReceiptV1::Environment(value) => (
            AuthorityStatusV1::Present,
            value.reference.authority_id.clone(),
            Some(value.digest.to_string()),
            value.captured_at.clone(),
            Vec::new(),
        ),
        AuthorityReceiptV1::SourceAnchor(value) => (
            AuthorityStatusV1::Present,
            value.path.clone(),
            Some(value.content_digest.to_string()),
            value.captured_at.clone(),
            Vec::new(),
        ),
        AuthorityReceiptV1::Finding(value) => (
            AuthorityStatusV1::Present,
            value.rule_id.clone(),
            None,
            value.captured_at.clone(),
            value.source_refs.clone(),
        ),
        AuthorityReceiptV1::AgentTurn(value) => (
            value.status,
            value.reference.authority_id.clone(),
            None,
            value.captured_at.clone(),
            Vec::new(),
        ),
    };
    Ok(AuthorityReceiptSummaryV1 {
        reference: authority_reference_view(receipt.reference())?,
        status: convert_enum(status)?,
        label,
        digest,
        captured_at,
        related_refs: related
            .iter()
            .map(authority_reference_view)
            .collect::<anyhow::Result<Vec<_>>>()?,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn authority_typescript_export() {
        let output_path = std::env::var_os("RHO_AUTHORITY_BINDINGS_PATH")
            .expect("RHO_AUTHORITY_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                super::authority_resolve_refs,
                super::authority_list_receipts,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Authority TypeScript export must succeed");
    }
}
