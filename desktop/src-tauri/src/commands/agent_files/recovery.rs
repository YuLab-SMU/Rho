use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail, ensure};
use rho_store::{BorrowedStore, Store, StoreConnection, StoreExecutor};
use serde::Deserialize;
use serde_json::{Value, json};

use super::append_agent_file_mutation_event;
use crate::application_state::{run_store_executor_service, store_executor};
use crate::project::{ensure_editable_file_size, project_path};
use crate::{AppState, text_sha256};

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct AgentFileMutationLedger {
    pub(crate) mutation_id: String,
    pub(crate) action: String,
    pub(crate) path: String,
    pub(crate) operation: String,
    pub(crate) proposal_event_id: i64,
    pub(crate) expected_before_sha256: Option<String>,
    pub(crate) expected_before_absent: bool,
    #[serde(default)]
    pub(crate) restore_content_sha256: Option<String>,
    pub(crate) intended_after_sha256: Option<String>,
    pub(crate) intended_after_absent: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct AgentFileMutationRecoverySummary {
    pub(crate) recovered: usize,
    pub(crate) not_applied: usize,
    pub(crate) uncertain: usize,
}

pub(crate) enum AgentFileObservation {
    Absent,
    Digest(String),
    Unknown(String),
}

#[derive(Debug)]
pub(crate) enum AgentFileProposalMutationState {
    Available,
    Mutating,
    Applied(AgentFileMutationLedger),
    Undone,
    Stale,
    Uncertain,
}

pub(crate) struct AgentFileMutationEventRecord {
    pub(crate) turn_id: String,
    pub(crate) event_type: &'static str,
    pub(crate) title: &'static str,
    pub(crate) status: &'static str,
    pub(crate) path: String,
    pub(crate) operation: String,
    pub(crate) proposal_event_id: i64,
    pub(crate) details: Value,
}

pub(crate) async fn run_agent_file_store_service<R, F>(state: &AppState, operation: F) -> Result<R>
where
    R: Send + 'static,
    F: FnOnce(&mut BorrowedStore<'_>) -> Result<R> + Send + 'static,
{
    run_store_executor_service(store_executor(state).await?, operation).await
}

pub(crate) async fn persist_agent_file_mutation_event(
    state: &AppState,
    event: AgentFileMutationEventRecord,
) -> Result<()> {
    run_agent_file_store_service(state, move |store| {
        persist_agent_file_mutation_event_to_store(store, event)
    })
    .await
}

pub(crate) fn persist_agent_file_mutation_event_to_store(
    store: &mut Store<impl StoreConnection>,
    event: AgentFileMutationEventRecord,
) -> Result<()> {
    append_agent_file_mutation_event(
        store,
        &event.turn_id,
        event.event_type,
        event.title,
        event.status,
        &event.path,
        &event.operation,
        event.proposal_event_id,
        event.details,
    )
}

pub(crate) fn agent_file_mutation_details(
    event: &rho_store::AgentTurnEvent,
) -> Result<Option<Value>> {
    let details: Value = serde_json::from_str(&event.details_json)
        .context("Agent file mutation event details are malformed")?;
    let Some(details) = details.get("details").cloned() else {
        return Ok(None);
    };
    if details.get("mutation_id").and_then(Value::as_str).is_none() {
        return Ok(None);
    }
    Ok(Some(details))
}

pub(crate) fn persisted_agent_file_mutation_state(
    store: &Store<impl StoreConnection>,
    project_root: &str,
    turn_id: &str,
    proposal_event_id: i64,
) -> Result<AgentFileProposalMutationState> {
    let detail = store
        .get_agent_turn_detail(project_root, turn_id)?
        .context("Agent file proposal turn was not found in the active project")?;
    let mut state = AgentFileProposalMutationState::Available;
    let mut ledgers = HashMap::<String, AgentFileMutationLedger>::new();
    let mut successful_apply = None::<AgentFileMutationLedger>;

    for event in detail
        .events
        .iter()
        .filter(|event| event.event_type.starts_with("file_edit."))
    {
        let envelope: Value = serde_json::from_str(&event.details_json)
            .context("Agent file mutation event details are malformed")?;
        if envelope.get("proposal_event_id").and_then(Value::as_i64) != Some(proposal_event_id) {
            continue;
        }
        let details = envelope
            .get("details")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let action = details
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                if event.event_type == "file_edit.undone" {
                    "undo"
                } else {
                    "apply"
                }
            });

        match event.event_type.as_str() {
            "file_edit.mutation_started" => {
                let ledger: AgentFileMutationLedger = serde_json::from_value(details)
                    .context("Agent file mutation ledger is malformed")?;
                ensure!(
                    ledger.proposal_event_id == proposal_event_id
                        && ledger.path == envelope["path"].as_str().unwrap_or_default()
                        && ledger.operation == envelope["operation"].as_str().unwrap_or_default()
                        && matches!(ledger.action.as_str(), "apply" | "undo"),
                    "Agent file mutation ledger does not match its event"
                );
                ledgers.insert(ledger.mutation_id.clone(), ledger);
                state = AgentFileProposalMutationState::Mutating;
            }
            "file_edit.applied" | "file_edit.recovered" if action == "apply" => {
                let mutation_id = details
                    .get("mutation_id")
                    .and_then(Value::as_str)
                    .context("Applied Agent file mutation omitted its ledger identity")?;
                let ledger = ledgers
                    .get(mutation_id)
                    .cloned()
                    .context("Applied Agent file mutation has no matching start record")?;
                ensure!(
                    ledger.action == "apply",
                    "Applied Agent file mutation references the wrong action"
                );
                successful_apply = Some(ledger.clone());
                state = AgentFileProposalMutationState::Applied(ledger);
            }
            "file_edit.undone" | "file_edit.recovered" if action == "undo" => {
                let mutation_id = details
                    .get("mutation_id")
                    .and_then(Value::as_str)
                    .context("Undone Agent file mutation omitted its ledger identity")?;
                let ledger = ledgers
                    .get(mutation_id)
                    .context("Undone Agent file mutation has no matching start record")?;
                ensure!(
                    ledger.action == "undo" && successful_apply.is_some(),
                    "Agent file Undo has no durable applied predecessor"
                );
                state = AgentFileProposalMutationState::Undone;
            }
            "file_edit.mutation_not_applied"
            | "file_edit.mutation_failed"
            | "file_edit.cancelled" => {
                state = if let Some(applied) = successful_apply.clone() {
                    AgentFileProposalMutationState::Applied(applied)
                } else {
                    AgentFileProposalMutationState::Available
                };
            }
            "file_edit.resource_stale" => {
                state = AgentFileProposalMutationState::Stale;
            }
            "file_edit.outcome_uncertain" => {
                state = AgentFileProposalMutationState::Uncertain;
            }
            _ => {}
        }
    }
    Ok(state)
}

pub(crate) fn ensure_agent_file_apply_available(
    state: AgentFileProposalMutationState,
) -> Result<()> {
    match state {
        AgentFileProposalMutationState::Available => Ok(()),
        AgentFileProposalMutationState::Mutating => {
            bail!("AGENT_FILE_MUTATION_BUSY: This Agent file proposal is already being changed.")
        }
        AgentFileProposalMutationState::Applied(_) | AgentFileProposalMutationState::Undone => {
            bail!("AGENT_FILE_ALREADY_DECIDED: This Agent file proposal was already applied.")
        }
        AgentFileProposalMutationState::Stale => {
            bail!(
                "AGENT_FILE_RESOURCE_STALE: This Agent file proposal is stale; generate a fresh proposal."
            )
        }
        AgentFileProposalMutationState::Uncertain => bail!(
            "AGENT_FILE_OUTCOME_UNCERTAIN: Inspect the current file before taking another action."
        ),
    }
}

pub(crate) fn durable_agent_file_undo_ledger(
    state: AgentFileProposalMutationState,
) -> Result<AgentFileMutationLedger> {
    match state {
        AgentFileProposalMutationState::Applied(ledger) => Ok(ledger),
        AgentFileProposalMutationState::Available => {
            bail!("AGENT_FILE_NOT_APPLIED: This Agent file proposal has not been applied.")
        }
        AgentFileProposalMutationState::Mutating => {
            bail!("AGENT_FILE_MUTATION_BUSY: This Agent file proposal is already being changed.")
        }
        AgentFileProposalMutationState::Undone => {
            bail!("AGENT_FILE_ALREADY_DECIDED: This Agent file proposal was already undone.")
        }
        AgentFileProposalMutationState::Stale => {
            bail!("AGENT_FILE_RESOURCE_STALE: This Agent file proposal no longer has a safe Undo.")
        }
        AgentFileProposalMutationState::Uncertain => bail!(
            "AGENT_FILE_OUTCOME_UNCERTAIN: Inspect the current file before taking another action."
        ),
    }
}

pub(crate) fn observe_agent_file(root: &Path, path: &str) -> AgentFileObservation {
    let file = match project_path(root, path) {
        Ok(file) => file,
        Err(error) => return AgentFileObservation::Unknown(error.to_string()),
    };
    if !file.exists() {
        return AgentFileObservation::Absent;
    }
    let metadata = match std::fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) => return AgentFileObservation::Unknown(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return AgentFileObservation::Unknown("target is not a regular project file".to_string());
    }
    if let Err(error) = ensure_editable_file_size(&file) {
        return AgentFileObservation::Unknown(error.to_string());
    }
    match std::fs::read_to_string(&file) {
        Ok(content) => AgentFileObservation::Digest(text_sha256(&content)),
        Err(error) => AgentFileObservation::Unknown(error.to_string()),
    }
}

pub(crate) fn observation_matches(
    observation: &AgentFileObservation,
    digest: Option<&str>,
    absent: bool,
) -> bool {
    match observation {
        AgentFileObservation::Absent => absent,
        AgentFileObservation::Digest(actual) => digest == Some(actual.as_str()),
        AgentFileObservation::Unknown(_) => false,
    }
}

pub(crate) fn pending_agent_file_mutations(
    store: &Store<impl StoreConnection>,
    project_root: &str,
) -> Result<Vec<(String, AgentFileMutationLedger)>> {
    let events = store.agent_file_mutation_events(project_root)?;
    let mut pending = HashMap::<String, (String, AgentFileMutationLedger)>::new();
    for event in events {
        let details = agent_file_mutation_details(&event)?;
        let Some(details) = details else {
            continue;
        };
        let mutation_id = details
            .get("mutation_id")
            .and_then(Value::as_str)
            .context("Agent file mutation ledger identity is missing")?
            .to_string();
        if event.event_type == "file_edit.mutation_started" {
            let ledger: AgentFileMutationLedger = serde_json::from_value(details)
                .context("Agent file mutation ledger is malformed")?;
            ensure!(
                !ledger.mutation_id.trim().is_empty()
                    && matches!(ledger.action.as_str(), "apply" | "undo")
                    && ledger.proposal_event_id > 0,
                "Agent file mutation ledger identity is invalid"
            );
            pending.insert(ledger.mutation_id.clone(), (event.turn_id, ledger));
        } else {
            pending.remove(&mutation_id);
        }
    }

    Ok(pending.into_values().collect())
}

pub(crate) fn observe_agent_file_recovery(
    root: &Path,
    pending: Vec<(String, AgentFileMutationLedger)>,
) -> (
    AgentFileMutationRecoverySummary,
    Vec<AgentFileMutationEventRecord>,
) {
    let mut summary = AgentFileMutationRecoverySummary::default();
    let mut events = Vec::with_capacity(pending.len());
    for (turn_id, ledger) in pending {
        let observation = observe_agent_file(root, &ledger.path);
        let (event_type, title, status, outcome, reason) = if observation_matches(
            &observation,
            ledger.intended_after_sha256.as_deref(),
            ledger.intended_after_absent,
        ) {
            summary.recovered += 1;
            (
                "file_edit.recovered",
                "Agent file mutation recovered from disk",
                "completed",
                "observed_intended_after",
                None,
            )
        } else if observation_matches(
            &observation,
            ledger.expected_before_sha256.as_deref(),
            ledger.expected_before_absent,
        ) {
            summary.not_applied += 1;
            (
                "file_edit.mutation_not_applied",
                "Agent file mutation did not reach disk",
                "failed",
                "observed_expected_before",
                None,
            )
        } else {
            summary.uncertain += 1;
            let reason = match &observation {
                AgentFileObservation::Unknown(reason) => Some(reason.clone()),
                _ => Some(
                    "disk content matches neither the recorded before nor after state".to_string(),
                ),
            };
            (
                "file_edit.outcome_uncertain",
                "Agent file mutation outcome needs review",
                "error",
                "outcome_uncertain",
                reason,
            )
        };
        events.push(AgentFileMutationEventRecord {
            turn_id,
            event_type,
            title,
            status,
            path: ledger.path,
            operation: ledger.operation,
            proposal_event_id: ledger.proposal_event_id,
            details: json!({
                "mutation_id": ledger.mutation_id,
                "action": ledger.action,
                "outcome": outcome,
                "reason": reason
            }),
        });
    }
    (summary, events)
}

pub(crate) async fn recover_incomplete_agent_file_mutations(
    executor: &StoreExecutor,
    root: &Path,
    project_root: &str,
) -> Result<AgentFileMutationRecoverySummary> {
    let project_root = project_root.to_string();
    let pending = run_store_executor_service(executor, move |store| {
        pending_agent_file_mutations(store, &project_root)
    })
    .await?;
    let (summary, events) = observe_agent_file_recovery(root, pending);
    if events.is_empty() {
        return Ok(summary);
    }
    run_store_executor_service(executor, move |store| {
        for event in events {
            persist_agent_file_mutation_event_to_store(store, event)?;
        }
        Ok(())
    })
    .await?;
    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn classify_agent_file_write_failure(
    root: &Path,
    turn_id: &str,
    path: &str,
    operation: &str,
    proposal_event_id: i64,
    mutation_id: &str,
    action: &str,
    expected_before_sha256: Option<&str>,
    expected_before_absent: bool,
    error: &anyhow::Error,
) -> (AgentFileMutationEventRecord, anyhow::Error) {
    let observation = observe_agent_file(root, path);
    let unchanged =
        observation_matches(&observation, expected_before_sha256, expected_before_absent);
    let (event_type, title, status, code) = if unchanged {
        (
            "file_edit.mutation_failed",
            "Agent file mutation failed before changing disk",
            "failed",
            "AGENT_FILE_WRITE_FAILED",
        )
    } else {
        (
            "file_edit.outcome_uncertain",
            "Agent file mutation outcome needs review",
            "error",
            "AGENT_FILE_OUTCOME_UNCERTAIN",
        )
    };
    let observation_detail = match observation {
        AgentFileObservation::Absent => "absent".to_string(),
        AgentFileObservation::Digest(digest) => digest,
        AgentFileObservation::Unknown(reason) => format!("unknown: {reason}"),
    };
    (
        AgentFileMutationEventRecord {
            turn_id: turn_id.to_string(),
            event_type,
            title,
            status,
            path: path.to_string(),
            operation: operation.to_string(),
            proposal_event_id,
            details: json!({
                "mutation_id": mutation_id,
                "action": action,
                "error": error.to_string(),
                "observation": observation_detail
            }),
        },
        anyhow!("{code}: The Agent file {action} did not complete cleanly: {error}"),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn persist_agent_file_write_failure(
    state: &AppState,
    root: &Path,
    turn_id: &str,
    path: &str,
    operation: &str,
    proposal_event_id: i64,
    mutation_id: &str,
    action: &str,
    expected_before_sha256: Option<&str>,
    expected_before_absent: bool,
    error: &anyhow::Error,
) -> anyhow::Error {
    let (event, result) = classify_agent_file_write_failure(
        root,
        turn_id,
        path,
        operation,
        proposal_event_id,
        mutation_id,
        action,
        expected_before_sha256,
        expected_before_absent,
        error,
    );
    let _ = persist_agent_file_mutation_event(state, event).await;
    result
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn classify_agent_file_postwrite_failure(
    turn_id: &str,
    path: &str,
    operation: &str,
    proposal_event_id: i64,
    mutation_id: &str,
    action: &str,
    error: &anyhow::Error,
) -> (AgentFileMutationEventRecord, anyhow::Error) {
    (
        AgentFileMutationEventRecord {
            turn_id: turn_id.to_string(),
            event_type: "file_edit.outcome_uncertain",
            title: "Agent file mutation outcome needs review",
            status: "error",
            path: path.to_string(),
            operation: operation.to_string(),
            proposal_event_id,
            details: json!({
                "mutation_id": mutation_id,
                "action": action,
                "error": error.to_string(),
                "reason": "postwrite_persistence_failed"
            }),
        },
        anyhow!(
            "AGENT_FILE_OUTCOME_UNCERTAIN: The file reached its intended disk state, but {action} persistence failed: {error}"
        ),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn persist_agent_file_postwrite_failure(
    state: &AppState,
    turn_id: &str,
    path: &str,
    operation: &str,
    proposal_event_id: i64,
    mutation_id: &str,
    action: &str,
    error: &anyhow::Error,
) -> anyhow::Error {
    let (event, result) = classify_agent_file_postwrite_failure(
        turn_id,
        path,
        operation,
        proposal_event_id,
        mutation_id,
        action,
        error,
    );
    let _ = persist_agent_file_mutation_event(state, event).await;
    result
}
