use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::local::ProcessIdentity;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TreeCancelState {
    NotRequested,
    Requested,
    SignalSent,
    ConfirmedDead,
    ReconcileRequired,
    AlreadyTerminal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TreeCancellationObservation {
    pub state: TreeCancelState,
    pub requested_at_ms: u64,
    pub confirmed_at_ms: Option<u64>,
    pub latency_ms: Option<u64>,
    pub whole_tree_targeted: bool,
    pub reason_code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeSignalResult {
    pub whole_tree_targeted: bool,
}

pub trait ProcessIdentityProbe {
    fn identity_matches(&mut self, identity: &ProcessIdentity) -> bool;
    fn whole_tree_dead(&mut self, identity: &ProcessIdentity) -> Option<bool>;
}

pub trait TreeSignalPort {
    fn terminate_tree(&mut self, identity: &ProcessIdentity) -> Result<TreeSignalResult, String>;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProcessTreeError {
    #[error("process identity no longer matches; refusing to signal reused PID")]
    IdentityMismatch,
    #[error("process tree signal failed")]
    SignalFailed,
}

pub struct ProcessTreeController<P, S> {
    probe: P,
    signal: S,
    state: TreeCancelState,
}

impl<P: ProcessIdentityProbe, S: TreeSignalPort> ProcessTreeController<P, S> {
    pub fn new(probe: P, signal: S) -> Self {
        Self {
            probe,
            signal,
            state: TreeCancelState::NotRequested,
        }
    }

    pub fn cancel(
        &mut self,
        identity: &ProcessIdentity,
        now_ms: u64,
        confirmation_deadline: Duration,
    ) -> Result<TreeCancellationObservation, ProcessTreeError> {
        if matches!(
            self.state,
            TreeCancelState::ConfirmedDead | TreeCancelState::AlreadyTerminal
        ) {
            return Ok(TreeCancellationObservation {
                state: TreeCancelState::AlreadyTerminal,
                requested_at_ms: now_ms,
                confirmed_at_ms: Some(now_ms),
                latency_ms: Some(0),
                whole_tree_targeted: true,
                reason_code: "already_terminal".to_string(),
            });
        }
        if !self.probe.identity_matches(identity) {
            self.state = TreeCancelState::ReconcileRequired;
            return Err(ProcessTreeError::IdentityMismatch);
        }
        self.state = TreeCancelState::Requested;
        let signal = self
            .signal
            .terminate_tree(identity)
            .map_err(|_| ProcessTreeError::SignalFailed)?;
        self.state = TreeCancelState::SignalSent;
        let started = Instant::now();
        while started.elapsed() <= confirmation_deadline {
            match self.probe.whole_tree_dead(identity) {
                Some(true) => {
                    self.state = TreeCancelState::ConfirmedDead;
                    let latency = started.elapsed().as_millis() as u64;
                    return Ok(TreeCancellationObservation {
                        state: self.state,
                        requested_at_ms: now_ms,
                        confirmed_at_ms: Some(now_ms.saturating_add(latency)),
                        latency_ms: Some(latency),
                        whole_tree_targeted: signal.whole_tree_targeted,
                        reason_code: "process_tree_confirmed_dead".to_string(),
                    });
                }
                Some(false) => std::thread::sleep(Duration::from_millis(2)),
                None => break,
            }
        }
        self.state = TreeCancelState::ReconcileRequired;
        Ok(TreeCancellationObservation {
            state: self.state,
            requested_at_ms: now_ms,
            confirmed_at_ms: None,
            latency_ms: None,
            whole_tree_targeted: signal.whole_tree_targeted,
            reason_code: if signal.whole_tree_targeted {
                "tree_death_unconfirmed"
            } else {
                "child_escape_guarantee_unavailable"
            }
            .to_string(),
        })
    }

    pub fn state(&self) -> TreeCancelState {
        self.state
    }
}

#[derive(Debug, Default)]
pub struct OsTreeSignalPort;

impl TreeSignalPort for OsTreeSignalPort {
    fn terminate_tree(&mut self, identity: &ProcessIdentity) -> Result<TreeSignalResult, String> {
        #[cfg(unix)]
        {
            let group = format!("-{}", identity.pid);
            let status = Command::new("/bin/kill")
                .args(["-KILL", &group])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|_| "kill failed".to_string())?;
            Ok(TreeSignalResult {
                whole_tree_targeted: status.success(),
            })
        }
        #[cfg(windows)]
        {
            let status = Command::new("taskkill")
                .args(["/PID", &identity.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|_| "taskkill failed".to_string())?;
            Ok(TreeSignalResult {
                whole_tree_targeted: status.success(),
            })
        }
        #[cfg(not(any(unix, windows)))]
        Err("process tree control unsupported".to_string())
    }
}

pub fn process_tree_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "identity_revalidation",
            "whole_tree_signal",
            "death_confirmation",
            "cancel_latency",
        ],
        &[
            "pid_only_kill",
            "unrelated_process_signal",
            "unconfirmed_success",
            "silent_child_escape",
        ],
    )
}
