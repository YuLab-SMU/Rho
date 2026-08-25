use std::path::Path;
use std::time::Duration;

use anyhow::{Result, ensure};
use rho_store::{
    EvidenceClaim, EvidenceClaimDraft, EvidenceClaimReview, EvidenceEntry, EvidenceEntryDraft,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::project::{ensure_editable_file, ensure_editable_file_size, project_path};
use crate::{AppState, display_error, store_executor};

#[derive(Deserialize)]
pub(crate) struct EvidenceClaimCreateRequest {
    kind: String,
    summary: String,
    anchor_kind: String,
    source_path: Option<String>,
    start_line: Option<i64>,
    start_column: Option<i64>,
    end_line: Option<i64>,
    end_column: Option<i64>,
    artifact_id: Option<String>,
    evidence_ids: Vec<i64>,
}

fn resolve_doi_citation(doi: &str) -> Option<Value> {
    let url = format!("https://api.crossref.org/works/{doi}");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .ok()?;
    let body: Value = resp.json().ok()?;
    let message = body.get("message")?;
    let title = message.get("title")?.as_array()?.first()?.as_str()?;
    let authors = message
        .get("author")
        .and_then(|v| v.as_array())
        .map(|authors| {
            authors
                .iter()
                .filter_map(|a| a.get("family").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let year = message
        .get("published-print")
        .or_else(|| message.get("published-online"))
        .or_else(|| message.get("issued"))
        .and_then(|v| v.get("date-parts"))
        .and_then(|v| v.as_array())
        .and_then(|parts| parts.first())
        .and_then(|p| p.as_array())
        .and_then(|p| p.first())
        .and_then(|y| y.as_i64());
    let journal = message
        .get("container-title")
        .and_then(|v| v.as_array())
        .and_then(|titles| titles.first())
        .and_then(|t| t.as_str());
    Some(json!({
        "title": title,
        "authors": authors,
        "year": year,
        "journal": journal,
    }))
}

#[tauri::command]
pub(crate) async fn resolve_doi(doi: String, _state: State<'_, AppState>) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || resolve_doi_citation(&doi))
        .await
        .map_err(|e| format!("DOI resolution failed: {e}"))
        .map(|v| v.unwrap_or(Value::Null))
}

#[tauri::command]
pub(crate) async fn create_evidence_entry(
    title: String,
    notes: Option<String>,
    doi: Option<String>,
    run_id: Option<String>,
    artifact_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<EvidenceEntry, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().into_owned();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .create_evidence_entry(EvidenceEntryDraft {
            project_root,
            title,
            notes: notes.unwrap_or_default(),
            doi,
            run_id,
            artifact_id,
        })
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn list_evidence_entries(
    limit: Option<usize>,
    search: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<EvidenceEntry>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    store_executor(&state)
        .await
        .map_err(display_error)?
        .list_evidence_entries(project_root, limit, search)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_evidence_entry(
    id: i64,
    state: State<'_, AppState>,
) -> Result<Option<EvidenceEntry>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    store_executor(&state)
        .await
        .map_err(display_error)?
        .get_evidence_entry(project_root, id)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn delete_evidence_entry(
    id: i64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().into_owned();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .delete_evidence_entry(project_root, id)
        .await
        .map_err(display_error)
}

pub(crate) fn source_claim_snapshot(
    root: &Path,
    path: &str,
    start_line: i64,
    end_line: i64,
) -> Result<(String, String)> {
    ensure!(
        start_line >= 1 && end_line >= start_line,
        "Claim source range is invalid"
    );
    ensure!(
        end_line - start_line < 200,
        "Claim source range exceeds 200 lines"
    );
    let file = project_path(root, path)?;
    ensure_editable_file(&file)?;
    ensure_editable_file_size(&file)?;
    let content = std::fs::read_to_string(&file)?;
    let lines = content.lines().collect::<Vec<_>>();
    ensure!(
        end_line as usize <= lines.len(),
        "Claim source range is outside the file"
    );
    let excerpt = lines[(start_line as usize - 1)..end_line as usize].join("\n");
    ensure!(
        excerpt.len() <= 16 * 1024,
        "Claim source excerpt exceeds 16 KiB"
    );
    let digest = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok((digest, excerpt))
}

#[tauri::command]
pub(crate) async fn create_evidence_claim(
    request: EvidenceClaimCreateRequest,
    state: State<'_, AppState>,
) -> Result<EvidenceClaim, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let (source_sha256, source_excerpt) = if request.anchor_kind == "source_range" {
        let path = request
            .source_path
            .as_deref()
            .ok_or_else(|| "Source path is required".to_string())?;
        let (digest, excerpt) = source_claim_snapshot(
            &root,
            path,
            request.start_line.unwrap_or(0),
            request.end_line.unwrap_or(0),
        )
        .map_err(display_error)?;
        (Some(digest), Some(excerpt))
    } else {
        (None, None)
    };
    store_executor(&state)
        .await
        .map_err(display_error)?
        .create_evidence_claim(EvidenceClaimDraft {
            project_root,
            kind: request.kind,
            summary: request.summary,
            anchor_kind: request.anchor_kind,
            source_path: request.source_path.map(|path| path.replace('\\', "/")),
            start_line: request.start_line,
            start_column: request.start_column,
            end_line: request.end_line,
            end_column: request.end_column,
            source_sha256,
            source_excerpt,
            artifact_id: request.artifact_id,
            evidence_ids: request.evidence_ids,
        })
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_evidence_claims(
    limit: Option<rho_ui_contract::UiIpcUsize>,
    state: State<'_, AppState>,
) -> Result<Vec<EvidenceClaim>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    store_executor(&state)
        .await
        .map_err(display_error)?
        .list_evidence_claims(project_root, limit.map(usize::from))
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn review_evidence_claim(
    claim_id: String,
    state: State<'_, AppState>,
) -> Result<EvidenceClaimReview, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let executor = store_executor(&state).await.map_err(display_error)?;
    let claim = executor
        .get_evidence_claim(project_root.clone(), claim_id.clone())
        .await
        .map_err(display_error)?;
    let source_resolved = claim.as_ref().and_then(|claim| {
        if claim.anchor_kind != "source_range" {
            return None;
        }
        let snapshot = source_claim_snapshot(
            &root,
            claim.source_path.as_deref()?,
            claim.start_line?,
            claim.end_line?,
        )
        .ok()?;
        Some(
            claim.source_sha256.as_deref() == Some(snapshot.0.as_str())
                && claim.source_excerpt.as_deref() == Some(snapshot.1.as_str()),
        )
    });
    executor
        .review_evidence_claim(project_root, claim_id, source_resolved)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn delete_evidence_claim(
    claim_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    store_executor(&state)
        .await
        .map_err(display_error)?
        .delete_evidence_claim(project_root, claim_id)
        .await
        .map_err(display_error)
}
