#![forbid(unsafe_code)]
//! Canonical Agent Provider runtime for lifecycle, logical sessions, turn cancellation, and event normalization.

use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{
    Actor, ActorKind, AgentProviderRequest, AgentProviderSnapshot, CapabilityId, EventId,
    EventValidationError, HotEventPayload, OperationId, SemanticEventPayload, StreamId, TraceId,
    TurnId,
};

pub mod install;
pub mod normalization;
pub mod process;
pub mod protocol;
pub mod providers;
pub mod session;
pub mod turn;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_DELTA_BYTES: usize = 64 * 1024;
pub const MAX_DIAGNOSTIC_BYTES: usize = 2048;
pub const DEFAULT_TURN_EVENT_QUOTA: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentHostBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> AgentHostBoundary {
    AgentHostBoundary {
        owns: &[
            "provider_lifecycle",
            "canonical_session_mapping",
            "turn_cancellation",
            "event_normalization",
        ],
        does_not_own: &[
            "policy_authority",
            "execution_mechanics",
            "scientific_truth",
            "store_handle",
            "workspace_handle",
            "secret_handle",
        ],
    }
}

pub trait HotEventSink {
    fn push_hot(
        &mut self,
        turn_id: &TurnId,
        payload: HotEventPayload,
    ) -> Result<(), AgentRuntimeError>;
}

pub trait DurableTransitionSink {
    fn push_semantic(
        &mut self,
        turn_id: &TurnId,
        payload: SemanticEventPayload,
    ) -> Result<(), AgentRuntimeError>;
}

pub trait AgentProvider {
    fn snapshot(&self) -> AgentProviderSnapshot;
    fn start_turn(&mut self, request: AgentTurnRequest) -> Vec<ProviderRuntimeEvent>;
    fn request_cancel(&mut self, turn_id: &TurnId) -> ProviderCancelReply;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTurnRequest {
    pub turn_id: TurnId,
    pub prompt_digest: String,
    pub deadline_epoch_ms: u64,
    pub event_quota: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProviderCancelReply {
    Accepted,
    AlreadyTerminal,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderRuntimeEvent {
    MessageDelta {
        cursor: u64,
        text: String,
    },
    PlanReplaced {
        plan_id: String,
    },
    CapabilityRequest {
        capability_id: CapabilityId,
        operation_id: OperationId,
        normalized_arguments: serde_json::Value,
    },
    Terminal {
        outcome: TurnTerminalOutcome,
    },
    Diagnostic {
        code: String,
        detail: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnTerminalOutcome {
    Completed,
    Failed,
    Cancelled,
    Crashed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CancelState {
    pub requested: bool,
    pub provider_confirmed: bool,
    pub process_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnRuntimeState {
    pub turn_id: TurnId,
    pub stream_id: StreamId,
    pub trace_id: TraceId,
    pub terminal: Option<TurnTerminalOutcome>,
    pub cancel: CancelState,
    pub emitted_events: usize,
    pub event_quota: usize,
}

impl TurnRuntimeState {
    fn new(turn_id: TurnId, stream_id: StreamId, trace_id: TraceId, event_quota: usize) -> Self {
        Self {
            turn_id,
            stream_id,
            trace_id,
            terminal: None,
            cancel: CancelState::default(),
            emitted_events: 0,
            event_quota,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BoundedDiagnostic {
    pub code: String,
    pub detail: String,
    pub truncated: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AgentRuntimeError {
    #[error("turn {0} is unknown")]
    UnknownTurn(TurnId),
    #[error("turn already has terminal event")]
    DuplicateTerminal,
    #[error("provider emitted event after terminal")]
    EventAfterTerminal,
    #[error("provider delta exceeds bound")]
    OversizedDelta,
    #[error("turn event quota exceeded")]
    EventQuotaExceeded,
    #[error("canonical event validation error: {0}")]
    EventValidation(String),
}

impl From<EventValidationError> for AgentRuntimeError {
    fn from(value: EventValidationError) -> Self {
        Self::EventValidation(value.to_string())
    }
}

#[derive(Debug, Default)]
pub struct AgentRuntime {
    turns: BTreeMap<TurnId, TurnRuntimeState>,
    completed_turns: BTreeSet<TurnId>,
    diagnostics: Vec<BoundedDiagnostic>,
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_turn(&mut self, request: AgentTurnRequest) -> &TurnRuntimeState {
        let turn_id = request.turn_id.clone();
        let state = TurnRuntimeState::new(
            turn_id.clone(),
            StreamId::generate(),
            TraceId::generate(),
            request.event_quota.max(1),
        );
        self.turns.insert(turn_id.clone(), state);
        self.turns.get(&turn_id).unwrap()
    }

    pub fn process_event(
        &mut self,
        turn_id: &TurnId,
        event: ProviderRuntimeEvent,
        hot: &mut impl HotEventSink,
        durable: &mut impl DurableTransitionSink,
    ) -> Result<(), AgentRuntimeError> {
        let state = self
            .turns
            .get_mut(turn_id)
            .ok_or_else(|| AgentRuntimeError::UnknownTurn(turn_id.clone()))?;
        if state.terminal.is_some() && !matches!(event, ProviderRuntimeEvent::Terminal { .. }) {
            let err = AgentRuntimeError::EventAfterTerminal;
            self.diagnostics
                .push(bound_diagnostic("event_after_terminal", &err.to_string()));
            return Err(err);
        }
        if state.emitted_events >= state.event_quota {
            let err = AgentRuntimeError::EventQuotaExceeded;
            self.diagnostics
                .push(bound_diagnostic("event_quota", &err.to_string()));
            return Err(err);
        }
        match event {
            ProviderRuntimeEvent::MessageDelta { cursor, text } => {
                if text.len() > MAX_DELTA_BYTES {
                    let err = AgentRuntimeError::OversizedDelta;
                    self.diagnostics
                        .push(bound_diagnostic("oversized_delta", &err.to_string()));
                    return Err(err);
                }
                hot.push_hot(
                    turn_id,
                    HotEventPayload::MessageDelta {
                        turn_id: turn_id.clone(),
                        cursor,
                        text,
                    },
                )?;
            }
            ProviderRuntimeEvent::PlanReplaced { plan_id } => durable.push_semantic(
                turn_id,
                SemanticEventPayload::PlanReplaced {
                    turn_id: turn_id.clone(),
                    plan_id,
                },
            )?,
            ProviderRuntimeEvent::CapabilityRequest {
                capability_id,
                operation_id,
                normalized_arguments,
            } => durable.push_semantic(
                turn_id,
                SemanticEventPayload::CapabilityRequested {
                    capability_id,
                    operation_id,
                    expected_revisions: rho_protocol::ExpectedRevisions {
                        workspace_id: rho_protocol::WorkspaceId::new("workspace_agent_runtime")
                            .unwrap(),
                        kernel_instance_id: rho_protocol::KernelInstanceId::new(
                            "kernel_agent_runtime",
                        )
                        .unwrap(),
                        state_revision: rho_protocol::StateRevision(0),
                        project_revision: rho_protocol::ProjectRevision(0),
                    },
                    normalized_arguments,
                },
            )?,
            ProviderRuntimeEvent::Terminal { outcome } => {
                if state.terminal.is_some() {
                    let err = AgentRuntimeError::DuplicateTerminal;
                    self.diagnostics
                        .push(bound_diagnostic("duplicate_terminal", &err.to_string()));
                    return Err(err);
                }
                state.terminal = Some(outcome);
                self.completed_turns.insert(turn_id.clone());
                match outcome {
                    TurnTerminalOutcome::Completed => durable.push_semantic(
                        turn_id,
                        SemanticEventPayload::TurnCompleted {
                            turn_id: turn_id.clone(),
                        },
                    )?,
                    TurnTerminalOutcome::Failed
                    | TurnTerminalOutcome::Cancelled
                    | TurnTerminalOutcome::Crashed => durable.push_semantic(
                        turn_id,
                        SemanticEventPayload::TurnFailed {
                            turn_id: turn_id.clone(),
                            reason_code: format!("{outcome:?}").to_ascii_lowercase(),
                        },
                    )?,
                }
            }
            ProviderRuntimeEvent::Diagnostic { code, detail } => {
                self.diagnostics.push(bound_diagnostic(&code, &detail));
            }
        }
        state.emitted_events += 1;
        Ok(())
    }

    pub fn request_cancel(
        &mut self,
        provider: &mut impl AgentProvider,
        turn_id: &TurnId,
    ) -> Result<ProviderCancelReply, AgentRuntimeError> {
        let state = self
            .turns
            .get_mut(turn_id)
            .ok_or_else(|| AgentRuntimeError::UnknownTurn(turn_id.clone()))?;
        state.cancel.requested = true;
        let reply = provider.request_cancel(turn_id);
        if matches!(
            reply,
            ProviderCancelReply::Accepted | ProviderCancelReply::AlreadyTerminal
        ) {
            state.cancel.provider_confirmed = true;
        }
        Ok(reply)
    }

    pub fn confirm_process_cancelled(&mut self, turn_id: &TurnId) -> Result<(), AgentRuntimeError> {
        let state = self
            .turns
            .get_mut(turn_id)
            .ok_or_else(|| AgentRuntimeError::UnknownTurn(turn_id.clone()))?;
        state.cancel.process_confirmed = true;
        Ok(())
    }

    pub fn turn(&self, turn_id: &TurnId) -> Option<&TurnRuntimeState> {
        self.turns.get(turn_id)
    }

    pub fn diagnostics(&self) -> &[BoundedDiagnostic] {
        &self.diagnostics
    }
}

pub fn bound_diagnostic(code: &str, detail: &str) -> BoundedDiagnostic {
    let truncated = detail.len() > MAX_DIAGNOSTIC_BYTES;
    BoundedDiagnostic {
        code: code.to_string(),
        detail: detail[..detail.len().min(MAX_DIAGNOSTIC_BYTES)].to_string(),
        truncated,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FakeProviderScenario {
    Normal,
    Slow,
    DuplicateTerminal,
    OutOfOrder,
    NoTerminal,
    Crash,
}

#[derive(Debug, Clone)]
pub struct FakeProvider {
    snapshot: AgentProviderSnapshot,
    scenario: FakeProviderScenario,
    cancelled: BTreeSet<TurnId>,
}

impl FakeProvider {
    pub fn new(scenario: FakeProviderScenario) -> Self {
        Self {
            snapshot: AgentProviderSnapshot {
                provider_id: rho_protocol::ProviderId::new("provider_fake").unwrap(),
                provider_version: "fake-1".to_string(),
                capability_ids: vec![CapabilityId::new("workspace.inspect").unwrap()],
                supports_resume: true,
                supports_cancel: true,
                max_payload_bytes: MAX_DELTA_BYTES as u64,
            },
            scenario,
            cancelled: BTreeSet::new(),
        }
    }
}

impl AgentProvider for FakeProvider {
    fn snapshot(&self) -> AgentProviderSnapshot {
        self.snapshot.clone()
    }

    fn start_turn(&mut self, _request: AgentTurnRequest) -> Vec<ProviderRuntimeEvent> {
        match self.scenario {
            FakeProviderScenario::Normal => vec![
                ProviderRuntimeEvent::MessageDelta {
                    cursor: 0,
                    text: "working".to_string(),
                },
                ProviderRuntimeEvent::CapabilityRequest {
                    capability_id: CapabilityId::new("workspace.inspect").unwrap(),
                    operation_id: OperationId::new("operation_fake_inspect").unwrap(),
                    normalized_arguments: serde_json::json!({"query":"objects"}),
                },
                ProviderRuntimeEvent::Terminal {
                    outcome: TurnTerminalOutcome::Completed,
                },
            ],
            FakeProviderScenario::Slow => vec![ProviderRuntimeEvent::MessageDelta {
                cursor: 0,
                text: "still working".to_string(),
            }],
            FakeProviderScenario::DuplicateTerminal => vec![
                ProviderRuntimeEvent::Terminal {
                    outcome: TurnTerminalOutcome::Completed,
                },
                ProviderRuntimeEvent::Terminal {
                    outcome: TurnTerminalOutcome::Failed,
                },
            ],
            FakeProviderScenario::OutOfOrder => vec![
                ProviderRuntimeEvent::Terminal {
                    outcome: TurnTerminalOutcome::Completed,
                },
                ProviderRuntimeEvent::MessageDelta {
                    cursor: 1,
                    text: "late".to_string(),
                },
            ],
            FakeProviderScenario::NoTerminal => vec![ProviderRuntimeEvent::MessageDelta {
                cursor: 0,
                text: "partial".to_string(),
            }],
            FakeProviderScenario::Crash => vec![ProviderRuntimeEvent::Terminal {
                outcome: TurnTerminalOutcome::Crashed,
            }],
        }
    }

    fn request_cancel(&mut self, turn_id: &TurnId) -> ProviderCancelReply {
        self.cancelled.insert(turn_id.clone());
        ProviderCancelReply::Accepted
    }
}

pub fn provider_can_cancel(snapshot: &AgentProviderSnapshot) -> bool {
    snapshot.supports_cancel
}

pub fn request_is_authoritative_effect(_: &AgentProviderRequest) -> bool {
    false
}

pub fn canonical_actor() -> Actor {
    Actor {
        kind: ActorKind::AgentProvider,
        id: "provider".to_string(),
    }
}

pub fn next_runtime_event_id() -> EventId {
    EventId::generate()
}
