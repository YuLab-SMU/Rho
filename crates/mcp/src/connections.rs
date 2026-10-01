//! Bounded, in-memory transport observations. These never grant authority or
//! retain scientific results. Each Workbench SelectedHost owns a fresh registry.
use rho_contract::McpSessionObservation;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_SESSIONS: usize = 64;

#[derive(Default)]
pub struct McpConnections(Mutex<State>);

#[derive(Default)]
struct State {
    next_id: u64,
    active: usize,
    sessions: VecDeque<McpSessionObservation>,
    truncated: bool,
}

pub struct ConnectionSnapshot {
    pub observed_at_ms: u64,
    pub active_sessions: usize,
    pub sessions: Vec<McpSessionObservation>,
    pub history_truncated: bool,
}

impl McpConnections {
    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn snapshot(&self) -> ConnectionSnapshot {
        let state = self.state();
        ConnectionSnapshot {
            observed_at_ms: now(),
            active_sessions: state.active,
            sessions: state.sessions.iter().rev().cloned().collect(),
            history_truncated: state.truncated,
        }
    }

    pub(crate) fn observe(self: &Arc<Self>) -> ConnectionObservation {
        let mut state = self.state();
        state.next_id += 1;
        ConnectionObservation {
            registry: self.clone(),
            id: format!("connection-{}", state.next_id),
            initialized: AtomicBool::new(false),
        }
    }
}

pub(crate) struct ConnectionObservation {
    registry: Arc<McpConnections>,
    id: String,
    initialized: AtomicBool,
}

impl ConnectionObservation {
    pub(crate) fn initialized(&self, name: Option<&str>, version: Option<&str>) {
        if self.initialized.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut state = self.registry.state();
        state.active += 1;
        if state.sessions.len() == MAX_SESSIONS {
            // Prefer retaining open sessions. If all are open, omit the oldest
            // detail while preserving an exact active count and truncation flag.
            let index = state
                .sessions
                .iter()
                .position(|s| s.closed_at_ms.is_some())
                .unwrap_or(0);
            state.sessions.remove(index);
            state.truncated = true;
        }
        let at = now();
        state.sessions.push_back(McpSessionObservation {
            connection_id: self.id.clone(),
            client_reported_name: name.map(label),
            client_reported_version: version.map(label),
            initialized_at_ms: at,
            last_request_at_ms: at,
            closed_at_ms: None,
            overview_served_at_ms: None,
        });
    }

    pub(crate) fn request(&self) {
        self.update(|session| session.last_request_at_ms = now());
    }

    pub(crate) fn served(&self, capability: &str, reply: &Value) {
        if reply.get("status").and_then(Value::as_str) != Some("ready") {
            return;
        }
        if capability == "host.overview" {
            self.update(|session| session.overview_served_at_ms = Some(now()));
        }
    }

    fn update(&self, update: impl FnOnce(&mut McpSessionObservation)) {
        let mut state = self.registry.state();
        if let Some(session) = state
            .sessions
            .iter_mut()
            .find(|s| s.connection_id == self.id)
        {
            update(session);
        }
    }
}

impl Drop for ConnectionObservation {
    fn drop(&mut self) {
        if self.initialized.load(Ordering::Acquire) {
            let mut state = self.registry.state();
            state.active -= 1;
            if let Some(session) = state
                .sessions
                .iter_mut()
                .find(|s| s.connection_id == self.id)
            {
                session.closed_at_ms = Some(now());
            }
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn label(value: &str) -> String {
    value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(128)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn handshake_is_required_and_drop_marks_closure_without_erasing_evidence() {
        let registry = Arc::new(McpConnections::default());
        let observer = registry.observe();
        assert!(registry.snapshot().sessions.is_empty());
        observer.initialized(Some("Codex\n\u{202e}"), Some("1"));
        observer.initialized(Some("another name"), None);
        observer.served("host.overview", &json!({"status":"busy"}));
        assert_eq!(registry.snapshot().active_sessions, 1);
        assert_eq!(
            registry.snapshot().sessions[0]
                .client_reported_name
                .as_deref(),
            Some("Codex")
        );
        assert!(
            registry.snapshot().sessions[0]
                .overview_served_at_ms
                .is_none()
        );
        observer.served("host.overview", &json!({"status":"ready","data":{}}));
        drop(observer);
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.active_sessions, 0);
        assert!(snapshot.sessions[0].closed_at_ms.is_some());
        assert!(snapshot.sessions[0].overview_served_at_ms.is_some());
    }

    #[test]
    fn overflow_is_explicit_and_closed_or_omitted_sessions_do_not_inflate_active_count() {
        let registry = Arc::new(McpConnections::default());
        let observers: Vec<_> = (0..80)
            .map(|_| {
                let observer = registry.observe();
                observer.initialized(Some(&"长".repeat(1024)), None);
                observer
            })
            .collect();
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.active_sessions, 80);
        assert_eq!(snapshot.sessions.len(), MAX_SESSIONS);
        assert_eq!(
            snapshot.sessions[0]
                .client_reported_name
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            128
        );
        assert!(snapshot.history_truncated);
        drop(observers);
        assert_eq!(registry.snapshot().active_sessions, 0);
        assert!(
            registry
                .snapshot()
                .sessions
                .iter()
                .all(|s| s.closed_at_ms.is_some())
        );
        assert!(McpConnections::default().snapshot().sessions.is_empty());
    }
}
