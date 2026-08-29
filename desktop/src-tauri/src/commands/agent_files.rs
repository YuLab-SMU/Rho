mod recovery;

pub(crate) use recovery::*;

use std::collections::HashMap;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result, anyhow, bail, ensure};
use rho_store::{AgentTurnEventDraft, Store, StoreConnection, normalize_project_root};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use tokio::sync::Mutex;
#[cfg(test)]
use tokio::sync::Notify;
use uuid::Uuid;

use crate::application_state::{active_context, persist_workspace_identity};
use crate::digest::text_sha256;
use crate::project::{
    ProjectState, atomic_write, atomic_write_new, ensure_editable_content_size,
    ensure_editable_file, ensure_editable_file_size, list_project_files, project_path,
    relative_project_path,
};
use crate::{AppState, display_error};

#[derive(Default)]
pub(crate) struct AgentFileMutationRegistry {
    pub(crate) lanes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub(crate) claims: StdMutex<HashMap<String, AgentFileMutationClaim>>,
}

#[derive(Clone)]
pub(crate) struct AgentFileMutationClaim {
    pub(crate) project_root: String,
    pub(crate) turn_id: String,
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) cancelled: bool,
}

pub(crate) struct AgentFileMutationClaimGuard {
    pub(crate) registry: Arc<AgentFileMutationRegistry>,
    pub(crate) claim_id: String,
}

#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct AgentFileApplyTestControl {
    pub(crate) completed_disk_writes: Arc<AtomicUsize>,
    pub(crate) completed_disk_write_notify: Arc<Notify>,
}

#[cfg(test)]
impl AgentFileApplyTestControl {
    pub(crate) fn record_completed_disk_write(&self) {
        self.completed_disk_writes.fetch_add(1, Ordering::SeqCst);
        self.completed_disk_write_notify.notify_waiters();
    }

    pub(crate) async fn wait_for_completed_disk_writes(&self, expected: usize) {
        loop {
            let notified = self.completed_disk_write_notify.notified();
            if self.completed_disk_writes.load(Ordering::SeqCst) >= expected {
                return;
            }
            notified.await;
        }
    }
}

impl AgentFileMutationRegistry {
    pub(crate) async fn lane(&self, key: &str) -> Arc<Mutex<()>> {
        let mut lanes = self.lanes.lock().await;
        lanes.retain(|_, lane| Arc::strong_count(lane) > 1);
        lanes
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(crate) fn register(
        self: &Arc<Self>,
        project_root: &str,
        turn_id: &str,
        path: &str,
    ) -> AgentFileMutationClaimGuard {
        let claim_id = format!("agent_file_mutation_{}", Uuid::new_v4().simple());
        self.claims
            .lock()
            .expect("Agent file mutation registry poisoned")
            .insert(
                claim_id.clone(),
                AgentFileMutationClaim {
                    project_root: project_root.to_string(),
                    turn_id: turn_id.to_string(),
                    path: path.to_string(),
                    status: "queued".to_string(),
                    cancelled: false,
                },
            );
        AgentFileMutationClaimGuard {
            registry: self.clone(),
            claim_id,
        }
    }

    pub(crate) fn begin_running(&self, claim_id: &str) -> bool {
        if let Some(claim) = self
            .claims
            .lock()
            .expect("Agent file mutation registry poisoned")
            .get_mut(claim_id)
        {
            if claim.cancelled {
                return false;
            }
            claim.status = "running".to_string();
            return true;
        }
        false
    }

    pub(crate) fn cancel_queued_turn(&self, turn_id: &str) -> usize {
        let mut claims = self
            .claims
            .lock()
            .expect("Agent file mutation registry poisoned");
        let mut cancelled = 0;
        for claim in claims.values_mut() {
            if claim.turn_id == turn_id && claim.status == "queued" {
                claim.cancelled = true;
                claim.status = "cancelled".to_string();
                cancelled += 1;
            }
        }
        cancelled
    }

    pub(crate) fn blocker(&self, project_root: &str) -> Option<(usize, AgentFileMutationClaim)> {
        let claims = self
            .claims
            .lock()
            .expect("Agent file mutation registry poisoned");
        let mut matching = claims
            .values()
            .filter(|claim| claim.project_root == project_root);
        let representative = matching.next()?.clone();
        let count = 1 + matching.count();
        Some((count, representative))
    }

    pub(crate) fn snapshot(&self, project_root: &str) -> Vec<(String, AgentFileMutationClaim)> {
        let claims = self
            .claims
            .lock()
            .expect("Agent file mutation registry poisoned");
        let mut matching = claims
            .iter()
            .filter(|(_, claim)| claim.project_root == project_root)
            .map(|(claim_id, claim)| (claim_id.clone(), claim.clone()))
            .collect::<Vec<_>>();
        matching.sort_by(|left, right| left.0.cmp(&right.0));
        matching
    }

    pub(crate) fn has_any_turn(&self, turn_ids: &[String]) -> bool {
        self.claims
            .lock()
            .expect("Agent file mutation registry poisoned")
            .values()
            .any(|claim| turn_ids.iter().any(|turn_id| turn_id == &claim.turn_id))
    }
}

impl Drop for AgentFileMutationClaimGuard {
    fn drop(&mut self) {
        self.registry
            .claims
            .lock()
            .expect("Agent file mutation registry poisoned")
            .remove(&self.claim_id);
    }
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentFileApplyRequest {
    pub(crate) turn_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) proposal_event_id: i64,
    pub(crate) path: String,
    pub(crate) expected_disk_sha256: Option<String>,
    pub(crate) before_content: String,
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentFileUndoRequest {
    pub(crate) turn_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) proposal_event_id: i64,
    pub(crate) path: String,
    pub(crate) expected_after_sha256: String,
    pub(crate) before_content: String,
    pub(crate) created: bool,
}

#[allow(dead_code)] // Code-generation mirror for ProjectState's serialized shape.
#[derive(Debug, Clone, specta::Type)]
pub(crate) struct AgentFileProjectFileWire {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) size_bytes: u64,
}

#[allow(dead_code)] // Code-generation mirror for ProjectState's serialized shape.
#[derive(Debug, Clone, specta::Type)]
pub(crate) struct AgentFileProjectStateWire {
    pub(crate) root: String,
    pub(crate) files: Vec<AgentFileProjectFileWire>,
    pub(crate) truncated: bool,
}

#[allow(dead_code)] // Code-generation mirror avoids adding Specta to rho-protocol.
#[derive(Debug, Clone, specta::Type)]
pub(crate) struct AgentFileWorkspaceIdentityWire {
    pub(crate) workspace_id: String,
    pub(crate) kernel_instance_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) execution_seq: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) state_revision: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) project_revision: u64,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentFileMutationResponse {
    pub(crate) status: String,
    pub(crate) path: String,
    pub(crate) content: Option<String>,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) start: usize,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) end: usize,
    pub(crate) after_sha256: Option<String>,
    #[specta(type = AgentFileProjectStateWire)]
    pub(crate) project: ProjectState,
    #[specta(type = AgentFileWorkspaceIdentityWire)]
    pub(crate) workspace: rho_protocol::WorkspaceIdentity,
}

#[derive(Clone)]
pub(crate) struct PersistedAgentFileProposal {
    pub(crate) path: String,
    pub(crate) operation: String,
    pub(crate) content: String,
    pub(crate) editor_context: Option<Value>,
}

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn utf16_offset_to_byte_index(content: &str, offset: usize) -> Option<usize> {
    if offset == 0 {
        return Some(0);
    }
    let mut utf16_offset = 0;
    for (byte_index, character) in content.char_indices() {
        if utf16_offset == offset {
            return Some(byte_index);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > offset {
            return None;
        }
    }
    (utf16_offset == offset).then_some(content.len())
}

pub(crate) fn persisted_agent_file_proposal(
    store: &Store<impl StoreConnection>,
    project_root: &str,
    turn_id: &str,
    proposal_event_id: i64,
) -> Result<PersistedAgentFileProposal> {
    ensure!(
        proposal_event_id > 0,
        "Agent file proposal event identity is invalid"
    );
    let detail = store
        .get_agent_turn_detail(project_root, turn_id)?
        .context("Agent file proposal turn was not found in the active project")?;
    let event = detail
        .events
        .iter()
        .find(|event| event.id == proposal_event_id)
        .context("Agent file proposal event was not found on the requested turn")?;
    ensure!(
        event.event_type == "tool.call_completed"
            && event.tool.as_deref() == Some("propose_file_edit"),
        "Agent file proposal event has the wrong type"
    );
    let details: Value = serde_json::from_str(&event.details_json)
        .context("Agent file proposal event details are malformed")?;
    let body = event
        .body
        .as_deref()
        .and_then(|body| serde_json::from_str::<Value>(body).ok());
    let proposal = body
        .filter(|value| value.get("kind").and_then(Value::as_str) == Some("rho.file_edit_proposal"))
        .or_else(|| {
            (details.get("success").and_then(Value::as_bool) == Some(true))
                .then(|| details.get("arguments").cloned())
                .flatten()
                .map(|arguments| {
                    let mut proposal = arguments;
                    if let Some(object) = proposal.as_object_mut() {
                        object.insert(
                            "kind".to_string(),
                            Value::String("rho.file_edit_proposal".to_string()),
                        );
                    }
                    proposal
                })
        })
        .context("Agent file proposal payload is unavailable")?;
    ensure!(
        proposal.get("kind").and_then(Value::as_str) == Some("rho.file_edit_proposal"),
        "Agent file proposal payload has the wrong kind"
    );
    let path = proposal
        .get("path")
        .and_then(Value::as_str)
        .context("Agent file proposal path is missing")?
        .to_string();
    let operation = proposal
        .get("operation")
        .and_then(Value::as_str)
        .context("Agent file proposal operation is missing")?
        .to_string();
    ensure!(
        matches!(
            operation.as_str(),
            "replace_selection" | "insert_at_cursor" | "append" | "create"
        ),
        "Agent file proposal operation is unsupported"
    );
    let content = proposal
        .get("content")
        .and_then(Value::as_str)
        .context("Agent file proposal content is missing")?
        .to_string();
    let editor_context = detail
        .events
        .iter()
        .find(|event| event.event_type == "agent.user_prompt")
        .and_then(|event| serde_json::from_str::<Value>(&event.details_json).ok())
        .and_then(|details| details.get("editor_context").cloned());
    Ok(PersistedAgentFileProposal {
        path,
        operation,
        content,
        editor_context,
    })
}

pub(crate) fn ensure_agent_file_proposal_turn_terminal(
    store: &Store<impl StoreConnection>,
    project_root: &str,
    turn_id: &str,
) -> Result<()> {
    let detail = store
        .get_agent_turn_detail(project_root, turn_id)?
        .context("Agent file proposal turn was not found in the active project")?;
    ensure!(
        !matches!(
            detail.turn.status.as_str(),
            "queued" | "running" | "waiting"
        ),
        "AGENT_FILE_TURN_ACTIVE: Wait for this Agent turn to finish before accepting its file proposal."
    );
    Ok(())
}

pub(crate) fn validate_persisted_agent_file_proposal_structure(
    proposal: &PersistedAgentFileProposal,
) -> Result<()> {
    if !matches!(
        proposal.operation.as_str(),
        "replace_selection" | "insert_at_cursor"
    ) {
        return Ok(());
    }
    let context = proposal
        .editor_context
        .as_ref()
        .context("AGENT_FILE_PROPOSAL_INVALID: The proposal omitted its editor context.")?;
    ensure!(
        context.get("active_path").and_then(Value::as_str) == Some(proposal.path.as_str()),
        "AGENT_FILE_PROPOSAL_INVALID: The proposal target does not match the captured active file."
    );
    let start = context
        .get("selection_start")
        .and_then(Value::as_u64)
        .context("AGENT_FILE_PROPOSAL_INVALID: The proposal start offset is missing.")?;
    let end = context
        .get("selection_end")
        .and_then(Value::as_u64)
        .context("AGENT_FILE_PROPOSAL_INVALID: The proposal end offset is missing.")?;
    ensure!(
        end >= start,
        "AGENT_FILE_PROPOSAL_INVALID: The proposal range is inverted."
    );
    if proposal.operation == "replace_selection" {
        let selection = context
            .get("selection_text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        ensure!(
            end > start && !selection.is_empty(),
            "AGENT_FILE_PROPOSAL_INVALID: Replace selection requires non-empty text selected when the turn starts."
        );
    } else {
        ensure!(
            end == start,
            "AGENT_FILE_PROPOSAL_INVALID: Insert at cursor requires an empty captured range."
        );
    }
    Ok(())
}

pub(crate) fn calculate_persisted_agent_file_edit(
    proposal: &PersistedAgentFileProposal,
    before_content: &str,
) -> Result<(String, usize, usize)> {
    let inserted = proposal.content.as_str();
    match proposal.operation.as_str() {
        "create" => {
            ensure!(
                before_content.is_empty(),
                "A create proposal cannot use existing editor content"
            );
            Ok((inserted.to_string(), 0, inserted.encode_utf16().count()))
        }
        "append" => {
            let start = before_content.encode_utf16().count();
            Ok((
                format!("{before_content}{inserted}"),
                start,
                start + inserted.encode_utf16().count(),
            ))
        }
        "replace_selection" | "insert_at_cursor" => {
            let context = proposal
                .editor_context
                .as_ref()
                .context("Agent file proposal omitted its editor context")?;
            ensure!(
                context.get("active_path").and_then(Value::as_str) == Some(proposal.path.as_str()),
                "Agent file proposal target no longer matches its editor context"
            );
            let start_utf16 = context
                .get("selection_start")
                .and_then(Value::as_u64)
                .context("Agent file proposal start offset is missing")?
                as usize;
            let end_utf16 = context
                .get("selection_end")
                .and_then(Value::as_u64)
                .context("Agent file proposal end offset is missing")?
                as usize;
            ensure!(
                end_utf16 >= start_utf16,
                "Agent file proposal range is inverted"
            );
            let start = utf16_offset_to_byte_index(before_content, start_utf16)
                .context("Agent file proposal start offset is no longer valid")?;
            let end = utf16_offset_to_byte_index(before_content, end_utf16)
                .context("Agent file proposal end offset is no longer valid")?;
            if proposal.operation == "replace_selection" {
                let selection = context
                    .get("selection_text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                ensure!(
                    start < end && &before_content[start..end] == selection,
                    "The selected text changed after this proposal was created"
                );
            } else {
                let before_anchor = context
                    .get("anchor_before")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let after_anchor = context
                    .get("anchor_after")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                ensure!(
                    before_content[..start].ends_with(before_anchor)
                        && before_content[end..].starts_with(after_anchor),
                    "The cursor context changed after this proposal was created"
                );
            }
            let content = format!(
                "{}{}{}",
                &before_content[..start],
                inserted,
                &before_content[end..]
            );
            Ok((
                content,
                start_utf16,
                start_utf16 + inserted.encode_utf16().count(),
            ))
        }
        _ => bail!("Agent file proposal operation is unsupported"),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn append_agent_file_mutation_event(
    store: &mut Store<impl StoreConnection>,
    turn_id: &str,
    event_type: &str,
    title: &str,
    status: &str,
    path: &str,
    operation: &str,
    proposal_event_id: i64,
    details: Value,
) -> Result<()> {
    store.append_agent_turn_event(&AgentTurnEventDraft {
        turn_id: turn_id.to_string(),
        event_type: event_type.to_string(),
        title: title.to_string(),
        body: Some(path.to_string()),
        status: status.to_string(),
        tool: Some("propose_file_edit".to_string()),
        request_id: None,
        code: None,
        details_json: serde_json::to_string(&json!({
            "path": path,
            "operation": operation,
            "proposal_event_id": proposal_event_id,
            "details": details
        }))?,
    })?;
    Ok(())
}

pub(crate) async fn record_agent_file_project_change(
    state: &AppState,
) -> Result<rho_protocol::WorkspaceIdentity> {
    let context = active_context(state).await?;
    let mut context = context.lock().await;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    persist_workspace_identity(&context.executor, identity.clone()).await?;
    Ok(identity)
}

pub(crate) async fn apply_agent_file_edit_state(
    request: AgentFileApplyRequest,
    state: &AppState,
) -> Result<AgentFileMutationResponse> {
    ensure_editable_content_size(&request.before_content)?;
    if let Some(expected) = request.expected_disk_sha256.as_deref() {
        ensure!(valid_sha256(expected), "Expected file digest is invalid");
    }
    let project_transition = state.project_transition_gate.lock().await;
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let file = project_path(&root, &request.path)?;
    ensure_editable_file(&file)?;
    let normalized_path = relative_project_path(&root, &file)?;
    ensure!(
        normalized_path == request.path,
        "Agent file proposal path is not normalized"
    );
    let terminal_project_root = project_root.clone();
    let terminal_turn_id = request.turn_id.clone();
    run_agent_file_store_service(state, move |store| {
        ensure_agent_file_proposal_turn_terminal(store, &terminal_project_root, &terminal_turn_id)
    })
    .await?;
    let lane_key = format!("{project_root}\0{normalized_path}");
    let task_registry = state.agent_tasks.lock().await;
    let claim =
        state
            .agent_file_mutations
            .register(&project_root, &request.turn_id, &normalized_path);
    drop(task_registry);
    drop(project_transition);
    let lane = state.agent_file_mutations.lane(&lane_key).await;
    let _lane_guard = lane.lock().await;
    let admitted = state.agent_file_mutations.begin_running(&claim.claim_id);

    if !admitted {
        persist_agent_file_mutation_event(
            state,
            AgentFileMutationEventRecord {
                turn_id: request.turn_id.clone(),
                event_type: "file_edit.cancelled",
                title: "Agent file proposal cancelled before admission",
                status: "interrupted",
                path: normalized_path.clone(),
                operation: "unknown".to_string(),
                proposal_event_id: request.proposal_event_id,
                details: json!({"action": "apply", "reason": "turn_cancelled_while_queued"}),
            },
        )
        .await?;
        bail!("AGENT_FILE_CANCELLED: The Agent file edit was cancelled before admission.");
    }
    let preflight_project_root = project_root.clone();
    let preflight_turn_id = request.turn_id.clone();
    let preflight_path = normalized_path.clone();
    let proposal_event_id = request.proposal_event_id;
    let proposal = run_agent_file_store_service(state, move |store| {
        ensure!(
            store.active_project_root()?.as_deref() == Some(preflight_project_root.as_str()),
            "AGENT_FILE_PROJECT_CHANGED: The active project changed before the file edit was admitted."
        );
        let proposal = persisted_agent_file_proposal(
            store,
            &preflight_project_root,
            &preflight_turn_id,
            proposal_event_id,
        )?;
        ensure!(
            proposal.path == preflight_path,
            "Agent file proposal path does not match its durable event"
        );
        validate_persisted_agent_file_proposal_structure(&proposal)?;
        ensure_agent_file_apply_available(persisted_agent_file_mutation_state(
            store,
            &preflight_project_root,
            &preflight_turn_id,
            proposal_event_id,
        )?)?;
        Ok(proposal)
    })
    .await?;

    let actual_disk_sha256 = if proposal.operation == "create" {
        ensure!(
            request.expected_disk_sha256.is_none(),
            "Create proposals must expect an absent file"
        );
        if file.exists() {
            persist_agent_file_mutation_event(
                state,
                AgentFileMutationEventRecord {
                    turn_id: request.turn_id.clone(),
                    event_type: "file_edit.resource_stale",
                    title: "Agent file proposal became stale",
                    status: "error",
                    path: normalized_path.clone(),
                    operation: proposal.operation.clone(),
                    proposal_event_id: request.proposal_event_id,
                    details: json!({"action": "apply", "reason": "create_target_exists"}),
                },
            )
            .await?;
            bail!(
                "AGENT_FILE_RESOURCE_STALE: Cannot create {} because the file now exists.",
                normalized_path
            );
        }
        None
    } else {
        if !file.exists() || !file.is_file() {
            persist_agent_file_mutation_event(
                state,
                AgentFileMutationEventRecord {
                    turn_id: request.turn_id.clone(),
                    event_type: "file_edit.resource_stale",
                    title: "Agent file proposal became stale",
                    status: "error",
                    path: normalized_path.clone(),
                    operation: proposal.operation.clone(),
                    proposal_event_id: request.proposal_event_id,
                    details: json!({"action": "apply", "reason": "edit_target_missing"}),
                },
            )
            .await?;
            bail!(
                "AGENT_FILE_RESOURCE_STALE: Cannot edit {} because the file no longer exists.",
                normalized_path
            );
        }
        ensure_editable_file_size(&file)?;
        let disk_content = std::fs::read_to_string(&file)?;
        let actual = text_sha256(&disk_content);
        let expected = request
            .expected_disk_sha256
            .as_deref()
            .context("Existing-file proposals require an expected disk digest")?;
        if actual != expected {
            persist_agent_file_mutation_event(
                state,
                AgentFileMutationEventRecord {
                    turn_id: request.turn_id.clone(),
                    event_type: "file_edit.resource_stale",
                    title: "Agent file proposal became stale",
                    status: "error",
                    path: normalized_path.clone(),
                    operation: proposal.operation.clone(),
                    proposal_event_id: request.proposal_event_id,
                    details: json!({"action": "apply", "reason": "content_digest_changed", "expected_sha256": expected, "actual_sha256": actual}),
                },
            )
            .await?;
            bail!(
                "AGENT_FILE_RESOURCE_STALE: {} changed before the Agent edit acquired its file lane.",
                normalized_path
            );
        }
        Some(actual)
    };

    let (content, start, end) = match calculate_persisted_agent_file_edit(
        &proposal,
        &request.before_content,
    ) {
        Ok(edit) => edit,
        Err(error) => {
            persist_agent_file_mutation_event(
                state,
                AgentFileMutationEventRecord {
                    turn_id: request.turn_id.clone(),
                    event_type: "file_edit.resource_stale",
                    title: "Agent file proposal became stale",
                    status: "error",
                    path: normalized_path.clone(),
                    operation: proposal.operation.clone(),
                    proposal_event_id: request.proposal_event_id,
                    details: json!({"action": "apply", "reason": "editor_context_changed", "detail": error.to_string()}),
                },
            )
            .await?;
            bail!(
                "AGENT_FILE_RESOURCE_STALE: {} no longer matches the proposal context: {}",
                normalized_path,
                error
            );
        }
    };
    ensure_editable_content_size(&content)?;
    let after_sha256 = text_sha256(&content);
    let mutation_id = format!("agent_file_mutation_{}", Uuid::new_v4().simple());
    persist_agent_file_mutation_event(
        state,
        AgentFileMutationEventRecord {
            turn_id: request.turn_id.clone(),
            event_type: "file_edit.mutation_started",
            title: "Agent file mutation admitted",
            status: "running",
            path: normalized_path.clone(),
            operation: proposal.operation.clone(),
            proposal_event_id: request.proposal_event_id,
            details: json!({
                "mutation_id": mutation_id,
                "action": "apply",
                "path": normalized_path,
                "operation": proposal.operation,
                "proposal_event_id": request.proposal_event_id,
                "expected_before_sha256": actual_disk_sha256,
                "expected_before_absent": proposal.operation == "create",
                "restore_content_sha256": text_sha256(&request.before_content),
                "intended_after_sha256": after_sha256,
                "intended_after_absent": false
            }),
        },
    )
    .await?;
    let write_result = if proposal.operation == "create" {
        atomic_write_new(&file, content.as_bytes())
    } else {
        atomic_write(&file, content.as_bytes())
    };
    if let Err(error) = write_result {
        return Err(persist_agent_file_write_failure(
            state,
            &root,
            &request.turn_id,
            &normalized_path,
            &proposal.operation,
            request.proposal_event_id,
            &mutation_id,
            "apply",
            actual_disk_sha256.as_deref(),
            proposal.operation == "create",
            &error,
        )
        .await);
    }
    #[cfg(test)]
    state
        .agent_file_apply_test_control
        .record_completed_disk_write();
    let identity = match record_agent_file_project_change(state).await {
        Ok(identity) => identity,
        Err(error) => {
            let error = anyhow!(error);
            return Err(persist_agent_file_postwrite_failure(
                state,
                &request.turn_id,
                &normalized_path,
                &proposal.operation,
                request.proposal_event_id,
                &mutation_id,
                "apply",
                &error,
            )
            .await);
        }
    };
    if let Err(error) = persist_agent_file_mutation_event(
        state,
        AgentFileMutationEventRecord {
            turn_id: request.turn_id.clone(),
            event_type: "file_edit.applied",
            title: "Agent file proposal applied",
            status: "completed",
            path: normalized_path.clone(),
            operation: proposal.operation.clone(),
            proposal_event_id: request.proposal_event_id,
            details: json!({
                "mutation_id": mutation_id,
                "action": "apply",
                "expected_disk_sha256": request.expected_disk_sha256,
                "actual_disk_sha256": actual_disk_sha256,
                "after_sha256": after_sha256
            }),
        },
    )
    .await
    {
        return Err(persist_agent_file_postwrite_failure(
            state,
            &request.turn_id,
            &normalized_path,
            &proposal.operation,
            request.proposal_event_id,
            &mutation_id,
            "apply",
            &error,
        )
        .await);
    }
    let project = list_project_files(&root)?;
    drop(claim);
    Ok(AgentFileMutationResponse {
        status: "applied".to_string(),
        path: normalized_path,
        content: Some(content),
        start,
        end,
        after_sha256: Some(after_sha256),
        project,
        workspace: identity,
    })
}

pub(crate) async fn undo_agent_file_edit_state(
    request: AgentFileUndoRequest,
    state: &AppState,
) -> Result<AgentFileMutationResponse> {
    ensure!(
        valid_sha256(&request.expected_after_sha256),
        "Expected applied-file digest is invalid"
    );
    ensure_editable_content_size(&request.before_content)?;
    let project_transition = state.project_transition_gate.lock().await;
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let file = project_path(&root, &request.path)?;
    ensure_editable_file(&file)?;
    let normalized_path = relative_project_path(&root, &file)?;
    ensure!(
        normalized_path == request.path,
        "Agent file proposal path is not normalized"
    );
    let lane_key = format!("{project_root}\0{normalized_path}");
    let task_registry = state.agent_tasks.lock().await;
    let claim =
        state
            .agent_file_mutations
            .register(&project_root, &request.turn_id, &normalized_path);
    drop(task_registry);
    drop(project_transition);
    let lane = state.agent_file_mutations.lane(&lane_key).await;
    let _lane_guard = lane.lock().await;
    let admitted = state.agent_file_mutations.begin_running(&claim.claim_id);

    if !admitted {
        persist_agent_file_mutation_event(
            state,
            AgentFileMutationEventRecord {
                turn_id: request.turn_id.clone(),
                event_type: "file_edit.cancelled",
                title: "Agent file Undo cancelled before admission",
                status: "interrupted",
                path: normalized_path.clone(),
                operation: "unknown".to_string(),
                proposal_event_id: request.proposal_event_id,
                details: json!({"action": "undo", "reason": "turn_cancelled_while_queued"}),
            },
        )
        .await?;
        bail!("AGENT_FILE_CANCELLED: The Agent file Undo was cancelled before admission.");
    }
    let preflight_project_root = project_root.clone();
    let preflight_turn_id = request.turn_id.clone();
    let preflight_path = normalized_path.clone();
    let proposal_event_id = request.proposal_event_id;
    let created = request.created;
    let (proposal, applied_ledger) = run_agent_file_store_service(state, move |store| {
        ensure!(
            store.active_project_root()?.as_deref() == Some(preflight_project_root.as_str()),
            "AGENT_FILE_PROJECT_CHANGED: The active project changed before Undo was admitted."
        );
        let proposal = persisted_agent_file_proposal(
            store,
            &preflight_project_root,
            &preflight_turn_id,
            proposal_event_id,
        )?;
        ensure!(
            proposal.path == preflight_path && (proposal.operation == "create") == created,
            "Agent file Undo does not match its durable proposal"
        );
        let applied_ledger = durable_agent_file_undo_ledger(persisted_agent_file_mutation_state(
            store,
            &preflight_project_root,
            &preflight_turn_id,
            proposal_event_id,
        )?)?;
        Ok((proposal, applied_ledger))
    })
    .await?;
    ensure!(
        applied_ledger.path == normalized_path
            && applied_ledger.operation == proposal.operation
            && applied_ledger.proposal_event_id == request.proposal_event_id
            && applied_ledger.expected_before_absent == request.created
            && !applied_ledger.intended_after_absent,
        "Agent file Undo does not match its durable Apply ledger"
    );
    ensure!(
        applied_ledger.intended_after_sha256.as_deref()
            == Some(request.expected_after_sha256.as_str()),
        "AGENT_FILE_RESOURCE_STALE: The requested Undo digest does not match the durable Apply result."
    );
    ensure!(
        applied_ledger.restore_content_sha256.as_deref()
            == Some(text_sha256(&request.before_content).as_str()),
        "AGENT_FILE_RESOURCE_STALE: The requested Undo content does not match the durable pre-Apply editor snapshot."
    );
    if request.created {
        ensure!(
            request.before_content.is_empty() && applied_ledger.expected_before_sha256.is_none(),
            "Agent file create Undo has invalid before-content state"
        );
    }
    if !file.exists() || !file.is_file() {
        persist_agent_file_mutation_event(
            state,
            AgentFileMutationEventRecord {
                turn_id: request.turn_id.clone(),
                event_type: "file_edit.resource_stale",
                title: "Agent file Undo became stale",
                status: "error",
                path: normalized_path.clone(),
                operation: proposal.operation.clone(),
                proposal_event_id: request.proposal_event_id,
                details: json!({"action": "undo", "reason": "undo_target_missing"}),
            },
        )
        .await?;
        bail!(
            "AGENT_FILE_RESOURCE_STALE: Cannot undo {} because the applied file is missing.",
            normalized_path
        );
    }
    ensure_editable_file_size(&file)?;
    let current = std::fs::read_to_string(&file)?;
    let actual_after_sha256 = text_sha256(&current);
    if actual_after_sha256 != request.expected_after_sha256 {
        persist_agent_file_mutation_event(
            state,
            AgentFileMutationEventRecord {
                turn_id: request.turn_id.clone(),
                event_type: "file_edit.resource_stale",
                title: "Agent file Undo became stale",
                status: "error",
                path: normalized_path.clone(),
                operation: proposal.operation.clone(),
                proposal_event_id: request.proposal_event_id,
                details: json!({
                    "action": "undo",
                    "reason": "undo_content_digest_changed",
                    "expected_sha256": request.expected_after_sha256,
                    "actual_sha256": actual_after_sha256
                }),
            },
        )
        .await?;
        bail!(
            "AGENT_FILE_RESOURCE_STALE: {} changed after the Agent edit, so automatic Undo was stopped.",
            normalized_path
        );
    }

    let after_sha256 = (!request.created).then(|| text_sha256(&request.before_content));
    let mutation_id = format!("agent_file_mutation_{}", Uuid::new_v4().simple());
    persist_agent_file_mutation_event(
        state,
        AgentFileMutationEventRecord {
            turn_id: request.turn_id.clone(),
            event_type: "file_edit.mutation_started",
            title: "Agent file Undo admitted",
            status: "running",
            path: normalized_path.clone(),
            operation: proposal.operation.clone(),
            proposal_event_id: request.proposal_event_id,
            details: json!({
                "mutation_id": mutation_id,
                "action": "undo",
                "path": normalized_path,
                "operation": proposal.operation,
                "proposal_event_id": request.proposal_event_id,
                "expected_before_sha256": actual_after_sha256,
                "expected_before_absent": false,
                "intended_after_sha256": after_sha256,
                "intended_after_absent": request.created
            }),
        },
    )
    .await?;
    let write_result = if request.created {
        crate::commands::project_session::safe_delete_project_file(&root, &normalized_path)
    } else {
        atomic_write(&file, request.before_content.as_bytes())
    };
    if let Err(error) = write_result {
        return Err(persist_agent_file_write_failure(
            state,
            &root,
            &request.turn_id,
            &normalized_path,
            &proposal.operation,
            request.proposal_event_id,
            &mutation_id,
            "undo",
            Some(&actual_after_sha256),
            false,
            &error,
        )
        .await);
    }
    let content = (!request.created).then_some(request.before_content);
    let identity = match record_agent_file_project_change(state).await {
        Ok(identity) => identity,
        Err(error) => {
            let error = anyhow!(error);
            return Err(persist_agent_file_postwrite_failure(
                state,
                &request.turn_id,
                &normalized_path,
                &proposal.operation,
                request.proposal_event_id,
                &mutation_id,
                "undo",
                &error,
            )
            .await);
        }
    };
    if let Err(error) = persist_agent_file_mutation_event(
        state,
        AgentFileMutationEventRecord {
            turn_id: request.turn_id.clone(),
            event_type: "file_edit.undone",
            title: "Agent file proposal undone",
            status: "completed",
            path: normalized_path.clone(),
            operation: proposal.operation.clone(),
            proposal_event_id: request.proposal_event_id,
            details: json!({
                "mutation_id": mutation_id,
                "action": "undo",
                "after_sha256": after_sha256
            }),
        },
    )
    .await
    {
        return Err(persist_agent_file_postwrite_failure(
            state,
            &request.turn_id,
            &normalized_path,
            &proposal.operation,
            request.proposal_event_id,
            &mutation_id,
            "undo",
            &error,
        )
        .await);
    }
    let project = list_project_files(&root)?;
    drop(claim);
    Ok(AgentFileMutationResponse {
        status: "undone".to_string(),
        path: normalized_path,
        content,
        start: 0,
        end: 0,
        after_sha256,
        project,
        workspace: identity,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn apply_agent_file_edit(
    request: AgentFileApplyRequest,
    state: State<'_, AppState>,
) -> Result<AgentFileMutationResponse, String> {
    apply_agent_file_edit_state(request, &state)
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn undo_agent_file_edit(
    request: AgentFileUndoRequest,
    state: State<'_, AppState>,
) -> Result<AgentFileMutationResponse, String> {
    undo_agent_file_edit_state(request, &state)
        .await
        .map_err(display_error)
}
