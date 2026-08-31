#![forbid(unsafe_code)]
//! Bounded hot-event hub for provider-neutral UI deltas.
//!
//! This crate owns only hot, non-durable delivery. Terminal state transitions remain
//! semantic events and must enter the store through the durable append path.

use std::{
    collections::{BTreeMap, VecDeque},
    num::NonZeroUsize,
};

use rho_protocol::{
    CanonicalEventType, EventChannel, HotEvent, HotEventPayload, SemanticEvent, SessionId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HotCursor(pub u64);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotFrame {
    pub cursor: HotCursor,
    pub event_type: CanonicalEventType,
    pub payload: Value,
    pub bytes: usize,
    pub coalesce_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HotGap {
    pub requested_after: HotCursor,
    pub oldest_available: HotCursor,
    pub latest: HotCursor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotRead {
    pub events: Vec<HotFrame>,
    pub gap: Option<HotGap>,
    pub completed_projection_fallback_required: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubMetrics {
    pub sessions: usize,
    pub total_bytes: usize,
    pub per_session_overflows: u64,
    pub global_overflows: u64,
    pub coalesced_deltas: u64,
    pub coalesced_progress: u64,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HubError {
    #[error("hot event hub quota must be non-zero")]
    ZeroQuota,
    #[error("event {0:?} is not a hot-only event")]
    NotHotEvent(CanonicalEventType),
    #[error("terminal transition {0:?} must use durable append, not the hot-only API")]
    TerminalRequiresDurableAppend(CanonicalEventType),
    #[error("hot event payload exceeds per-frame quota: {actual} > {limit}")]
    FrameTooLarge { limit: usize, actual: usize },
    #[error("hot event serialization failed: {0}")]
    Serialization(String),
}

#[derive(Debug, Clone)]
pub struct HotEventHub {
    per_session_quota: NonZeroUsize,
    global_quota: NonZeroUsize,
    sessions: BTreeMap<SessionId, SessionRing>,
    metrics: HubMetrics,
}

#[derive(Debug, Clone)]
struct SessionRing {
    frames: VecDeque<HotFrame>,
    next_cursor: u64,
    oldest_cursor: u64,
    bytes: usize,
}

impl HotEventHub {
    pub fn new(per_session_quota: usize, global_quota: usize) -> Result<Self, HubError> {
        Ok(Self {
            per_session_quota: NonZeroUsize::new(per_session_quota).ok_or(HubError::ZeroQuota)?,
            global_quota: NonZeroUsize::new(global_quota).ok_or(HubError::ZeroQuota)?,
            sessions: BTreeMap::new(),
            metrics: HubMetrics {
                sessions: 0,
                total_bytes: 0,
                per_session_overflows: 0,
                global_overflows: 0,
                coalesced_deltas: 0,
                coalesced_progress: 0,
            },
        })
    }

    pub fn publish(
        &mut self,
        session_id: SessionId,
        event: HotEvent,
    ) -> Result<HotCursor, HubError> {
        event
            .validate()
            .map_err(|_| HubError::NotHotEvent(event.event_type))?;
        if event.event_type.registry().channel != EventChannel::HotOnly {
            return Err(HubError::NotHotEvent(event.event_type));
        }
        let coalesce_key = coalesce_key(&event.payload);
        let mut payload = serde_json::to_value(&event.payload)
            .map_err(|error| HubError::Serialization(error.to_string()))?;
        let payload_bytes = encoded_len(&payload)?;
        if payload_bytes > self.per_session_quota.get() {
            return Err(HubError::FrameTooLarge {
                limit: self.per_session_quota.get(),
                actual: payload_bytes,
            });
        }
        let ring = self
            .sessions
            .entry(session_id.clone())
            .or_insert_with(SessionRing::new);
        let cursor = HotCursor(ring.next_cursor);
        ring.next_cursor += 1;
        if let Some(key) = &coalesce_key
            && let Some(last) = ring.frames.back_mut()
            && last.coalesce_key.as_ref() == Some(key)
        {
            if event.event_type == CanonicalEventType::MessageDelta {
                merge_text_delta(&mut last.payload, &payload);
                last.cursor = cursor;
                last.bytes = encoded_len(&last.payload)?;
                self.metrics.coalesced_deltas += 1;
            } else {
                payload["cursor"] = serde_json::json!(cursor.0);
                last.cursor = cursor;
                last.payload = payload;
                last.bytes = payload_bytes;
                self.metrics.coalesced_progress += 1;
            }
            ring.bytes = ring.frames.iter().map(|frame| frame.bytes).sum();
            self.enforce_session_quota(&session_id);
            self.enforce_global_quota();
            self.recompute_metrics();
            return Ok(cursor);
        }
        payload["cursor"] = serde_json::json!(cursor.0);
        ring.frames.push_back(HotFrame {
            cursor,
            event_type: event.event_type,
            payload,
            bytes: payload_bytes,
            coalesce_key,
        });
        ring.bytes += payload_bytes;
        self.enforce_session_quota(&session_id);
        self.enforce_global_quota();
        self.recompute_metrics();
        Ok(cursor)
    }

    pub fn reject_terminal_transition(&self, event: &SemanticEvent) -> Result<(), HubError> {
        Err(HubError::TerminalRequiresDurableAppend(event.event_type))
    }

    pub fn read(&self, session_id: &SessionId, after: HotCursor, limit: usize) -> HotRead {
        let Some(ring) = self.sessions.get(session_id) else {
            return HotRead {
                events: Vec::new(),
                gap: None,
                completed_projection_fallback_required: false,
            };
        };
        let gap = if after.0 < ring.oldest_cursor && !ring.frames.is_empty() {
            Some(HotGap {
                requested_after: after,
                oldest_available: HotCursor(ring.oldest_cursor),
                latest: HotCursor(ring.next_cursor.saturating_sub(1)),
            })
        } else {
            None
        };
        let events = ring
            .frames
            .iter()
            .filter(|frame| frame.cursor > after)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        HotRead {
            events,
            completed_projection_fallback_required: gap.is_some(),
            gap,
        }
    }

    pub fn metrics(&self) -> HubMetrics {
        self.metrics
    }

    fn enforce_session_quota(&mut self, session_id: &SessionId) {
        let Some(ring) = self.sessions.get_mut(session_id) else {
            return;
        };
        while ring.bytes > self.per_session_quota.get() {
            if let Some(frame) = ring.frames.pop_front() {
                ring.bytes = ring.bytes.saturating_sub(frame.bytes);
                ring.oldest_cursor = ring
                    .frames
                    .front()
                    .map(|frame| frame.cursor.0)
                    .unwrap_or(ring.next_cursor);
                self.metrics.per_session_overflows += 1;
            } else {
                break;
            }
        }
    }

    fn enforce_global_quota(&mut self) {
        while total_bytes(&self.sessions) > self.global_quota.get() {
            let Some(session_id) = self.oldest_session_id() else {
                break;
            };
            if let Some(ring) = self.sessions.get_mut(&session_id)
                && let Some(frame) = ring.frames.pop_front()
            {
                ring.bytes = ring.bytes.saturating_sub(frame.bytes);
                ring.oldest_cursor = ring
                    .frames
                    .front()
                    .map(|frame| frame.cursor.0)
                    .unwrap_or(ring.next_cursor);
                self.metrics.global_overflows += 1;
            }
        }
    }

    fn oldest_session_id(&self) -> Option<SessionId> {
        self.sessions
            .iter()
            .filter_map(|(session_id, ring)| {
                ring.frames
                    .front()
                    .map(|frame| (frame.cursor, session_id.clone()))
            })
            .min_by_key(|(cursor, _)| *cursor)
            .map(|(_, session_id)| session_id)
    }

    fn recompute_metrics(&mut self) {
        self.metrics.sessions = self.sessions.len();
        self.metrics.total_bytes = total_bytes(&self.sessions);
    }
}

impl SessionRing {
    fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            next_cursor: 1,
            oldest_cursor: 1,
            bytes: 0,
        }
    }
}

fn total_bytes(sessions: &BTreeMap<SessionId, SessionRing>) -> usize {
    sessions.values().map(|ring| ring.bytes).sum()
}

fn encoded_len(value: &Value) -> Result<usize, HubError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|error| HubError::Serialization(error.to_string()))
}

fn coalesce_key(payload: &HotEventPayload) -> Option<String> {
    match payload {
        HotEventPayload::MessageDelta { turn_id, .. } => {
            Some(format!("delta:{}", turn_id.as_str()))
        }
        HotEventPayload::UsageUpdated { provider_id, .. } => {
            Some(format!("progress:usage:{}", provider_id.as_str()))
        }
        _ => None,
    }
}

fn merge_text_delta(existing: &mut Value, incoming: &Value) {
    let current = existing
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let addition = incoming
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    existing["text"] = Value::String(format!("{current}{addition}"));
    if let Some(cursor) = incoming.get("cursor") {
        existing["provider_cursor"] = cursor.clone();
    }
}

pub fn boundary_hot_event_hub_does_not_own_durable_state() -> &'static str {
    "rho-event-hub owns hot-only bounded delivery; durable semantic state remains in rho-store"
}
