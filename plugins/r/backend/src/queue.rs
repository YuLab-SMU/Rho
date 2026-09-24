//! Native scheduling only. Terminal scientific truth comes from Host settlement.
use rho_plugin_sdk::protocol::{
    OperationId, OperationSettlement, PendingCancellation, PluginCall, PluginOutcome, ProviderBinding,
};
use rho_r_api::{ConsoleState, InputRequest, QueueControlArguments, QueuePause, QueuedRun};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as Lane, OwnedMutexGuard, watch};

pub const MAX_ACCEPTED: usize = 33; // One current run and up to 32 waiting results/runs.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Waiting,
    Running,
    AwaitingSettlement,
}
struct Entry {
    binding: ProviderBinding,
    run: QueuedRun,
    phase: Phase,
    native_outcome: Option<PluginOutcome>,
    pending_cancellation: bool,
}
#[derive(Default)]
struct State {
    entries: BTreeMap<OperationId, Entry>,
    pending: VecDeque<OperationId>,
    current: Option<OperationId>,
    pause: Option<QueuePause>,
    serial: u64,
    closing: bool,
}
#[derive(Serialize)]
pub struct Observation {
    pub console: ConsoleState,
    pub awaiting_commit: Vec<OperationId>,
    /// Native start is fenced; retry the original cancellation if its Host
    /// journal acknowledgement failed. This is not terminal cancellation.
    pub pending_cancellations: Vec<OperationId>,
    /// Native queue capacity only; Host lifecycle and grants still govern admission.
    pub accepting: bool,
    pub capacity: usize,
}
pub struct Queue {
    state: Mutex<State>,
    changed: watch::Sender<u64>,
}
impl Default for Queue {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            changed: watch::channel(0).0,
        }
    }
}
impl Queue {
    fn signal(&self) {
        self.changed
            .send_modify(|value| *value = value.wrapping_add(1));
    }
    /// Called by the single framed reader, before spawning execution, preserving
    /// the order this owner received accepted original operations.
    pub fn admit(&self, call: &PluginCall) -> Result<(), String> {
        let id = OperationId::new(
            call.operation_id
                .as_deref()
                .ok_or("Original operation required")?,
        )
        .map_err(|e| e.to_string())?;
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return Err("R owner is closing".into());
        }
        if state.entries.contains_key(&id) {
            return Err("Original operation is already in the native queue".into());
        }
        if state.entries.len() >= MAX_ACCEPTED {
            return Err(
                "R queue is full (33 accepted operations); keep the input and inspect the queue"
                    .into(),
            );
        }
        let run = call.arguments.get("run").unwrap_or(&call.arguments);
        let source = run
            .get("source")
            .filter(|value| !value.is_null())
            .map(|value| serde_json::from_value(value.clone()).map_err(|error| error.to_string()))
            .transpose()?;
        let summary = run
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Create R session")
            .chars()
            .take(160)
            .collect();
        state.entries.insert(
            id.clone(),
            Entry {
                binding: call.binding.clone(),
                run: QueuedRun {
                    operation_id: id.clone(),
                    source,
                    summary,
                },
                phase: Phase::Waiting,
                native_outcome: None,
                pending_cancellation: false,
            },
        );
        state.pending.push_back(id);
        drop(state);
        self.signal();
        Ok(())
    }
    pub fn observe(&self, session: &str, input: Option<InputRequest>) -> Observation {
        let state = self.state.lock().unwrap();
        Observation {
            console: ConsoleState {
                session_id: session.into(),
                current: state
                    .current
                    .as_ref()
                    .and_then(|id| state.entries.get(id))
                    .map(|e| e.run.clone()),
                pending: state
                    .pending
                    .iter()
                    .filter_map(|id| state.entries.get(id))
                    .map(|e| e.run.clone())
                    .collect(),
                pause: state.pause.clone(),
                input,
            },
            awaiting_commit: state
                .entries
                .iter()
                .filter(|(_, e)| e.phase == Phase::AwaitingSettlement)
                .map(|(id, _)| id.clone())
                .collect(),
            pending_cancellations: state.entries.iter()
                .filter(|(_, entry)| entry.pending_cancellation)
                .map(|(id, _)| id.clone()).collect(),
            accepting: !state.closing && state.entries.len() < MAX_ACCEPTED,
            capacity: MAX_ACCEPTED,
        }
    }
    pub fn is_empty(&self) -> bool {
        self.state.lock().unwrap().entries.is_empty()
    }
    pub fn prepare_pending_cancellation(&self, cancellation: &PendingCancellation) -> Result<bool, String> {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.entries.get_mut(&cancellation.operation_id) else { return Ok(false); };
        if entry.binding != cancellation.binding { return Err("Pending cancellation differs from the original binding".into()); }
        if entry.phase != Phase::Waiting { return Ok(false); }
        entry.pending_cancellation = true;
        drop(state);
        self.signal();
        Ok(true)
    }
    fn available(state: &State, id: &OperationId) -> bool {
        !state.closing
            && state.pause.is_none()
            && state.current.is_none()
            && state.pending.front() == Some(id)
            && state.entries.get(id).is_some_and(|entry| !entry.pending_cancellation)
            && !state
                .entries
                .values()
                .any(|e| e.phase == Phase::AwaitingSettlement)
    }
    /// None confirms cancellation before any native effect. The cancelled item
    /// still retains its scheduling fence until its original result is settled.
    pub async fn acquire(
        &self,
        id: &OperationId,
        lane: Arc<Lane<()>>,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<Option<OwnedMutexGuard<()>>, String> {
        let mut changed = self.changed.subscribe();
        loop {
            let available = {
                let mut state = self.state.lock().unwrap();
                let phase = state
                    .entries
                    .get(id)
                    .ok_or("Operation is not in this native queue")?
                    .phase;
                if phase != Phase::Waiting {
                    return Err("Operation has already left the waiting queue".into());
                }
                if *cancellation.borrow() || state.closing {
                    state.pending.retain(|pending| pending != id);
                    let entry = state.entries.get_mut(id).unwrap();
                    entry.phase = Phase::AwaitingSettlement;
                    entry.native_outcome = Some(PluginOutcome::Cancelled);
                    Self::pause(
                        &mut state,
                        Some(id.clone()),
                        "Pending run cancelled. Inspect its original result before resuming.",
                    );
                    drop(state);
                    self.signal();
                    return Ok(None);
                }
                Self::available(&state, id)
            };
            if available {
                let acquiring = lane.clone().lock_owned();
                tokio::pin!(acquiring);
                let guard = tokio::select! {
                    guard = &mut acquiring => Some(guard),
                    _ = changed.changed() => None,
                    _ = cancellation.changed(), if cancellation.has_changed().is_ok() => None,
                };
                if let Some(guard) = guard {
                    let mut state = self.state.lock().unwrap();
                    if !*cancellation.borrow() && Self::available(&state, id) {
                        state.pending.pop_front();
                        state.current = Some(id.clone());
                        state.entries.get_mut(id).unwrap().phase = Phase::Running;
                        drop(state);
                        self.signal();
                        return Ok(Some(guard));
                    }
                }
            } else {
                tokio::select! {
                    _ = changed.changed() => (),
                    _ = cancellation.changed(), if cancellation.has_changed().is_ok() => (),
                }
            }
        }
    }
    pub fn finished(&self, id: &OperationId, outcome: PluginOutcome) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let entry = state
            .entries
            .get_mut(id)
            .ok_or("Native result has no queued operation")?;
        if entry.phase == Phase::AwaitingSettlement && entry.native_outcome == Some(outcome) {
            return Ok(());
        }
        if entry.phase != Phase::Running {
            return Err("Native result arrived before acquiring its execution lane".into());
        }
        entry.phase = Phase::AwaitingSettlement;
        entry.native_outcome = Some(outcome);
        if outcome != PluginOutcome::Succeeded {
            Self::pause(
                &mut state,
                Some(id.clone()),
                "The run did not succeed. Inspect its original result before resuming.",
            );
        }
        drop(state);
        self.signal();
        Ok(())
    }
    /// No durable result copy is kept here. Once forgotten, a duplicate old ID
    /// is a no-op, even when a different operation is now running.
    pub fn settle(&self, settlement: &OperationSettlement) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let id = &settlement.operation_id;
        let Some(entry) = state.entries.get(id) else {
            return Ok(());
        };
        if entry.binding != settlement.binding || entry.phase != Phase::AwaitingSettlement {
            return Err("Settlement does not match a returned native operation".into());
        }
        if settlement.outcome == PluginOutcome::Succeeded
            && entry.native_outcome != Some(PluginOutcome::Succeeded)
        {
            return Err("Settlement cannot turn a failed native run into success".into());
        }
        if settlement.outcome != PluginOutcome::Succeeded
            && entry.native_outcome == Some(PluginOutcome::Succeeded)
        {
            Self::pause(
                &mut state,
                Some(id.clone()),
                "The Host could not confirm the native result. Inspect the original operation before resuming.",
            );
        }
        state.entries.remove(id);
        state.pending.retain(|pending| pending != id);
        if state.current.as_ref() == Some(id) {
            state.current = None;
        }
        drop(state);
        self.signal();
        Ok(())
    }
    fn pause(state: &mut State, id: Option<OperationId>, reason: &str) {
        state.serial += 1;
        state.pause = Some(QueuePause {
            id: format!("pause-{}", state.serial),
            operation_id: id,
            reason: reason.into(),
        });
    }
    /// A transient control acts only on this existing queue. It cannot supply
    /// journal success or bypass an item awaiting original Host settlement.
    pub fn control(&self, pause: bool, args: &QueueControlArguments) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return Err("R owner is closing".into());
        }
        if state.pause.as_ref().map(|p| p.id.as_str()) != args.pause_id.as_deref() {
            return Err("Queue pause changed; inspect the current queue".into());
        }
        if let Some(allowed) = &args.only_operation_ids {
            if allowed.is_empty()
                || allowed.len() > MAX_ACCEPTED + 1
                || state.entries.keys().any(|id| !allowed.contains(id))
                || state
                    .pause
                    .as_ref()
                    .and_then(|p| p.operation_id.as_ref())
                    .is_some_and(|id| !allowed.contains(id))
            {
                return Err("Queue contains work outside the supplied operation identities".into());
            }
        }
        if pause {
            if state.pause.is_none() {
                Self::pause(&mut state, None, "Queue paused. The current run continues.");
            }
        } else {
            if state.pause.is_none() {
                return Err("Observe an existing pause before resuming".into());
            }
            if state.entries.values().any(|entry| entry.pending_cancellation) {
                return Err("An original cancellation awaits journal confirmation; retry that cancellation before resuming".into());
            }
            if state
                .entries
                .values()
                .any(|e| e.phase == Phase::AwaitingSettlement)
            {
                return Err(
                    "An original result awaits Host settlement; queue control cannot confirm it"
                        .into(),
                );
            }
            state.pause = None;
        }
        drop(state);
        self.signal();
        Ok(())
    }
    pub fn begin_shutdown(&self) {
        self.state.lock().unwrap().closing = true;
        self.signal();
    }
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
