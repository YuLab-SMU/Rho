//! Bounded native observations. Synthetic keys identify observations, never
//! pretend to be native turn/item identities absent from a protocol frame.
use rho_contract::AgentProvider;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct NativeEvent {
    pub cursor: u64,
    pub key: String,
    pub request_id: Option<String>,
    pub session: String,
    pub turn: Option<String>,
    pub item: Option<String>,
    pub kind: String,
    pub role: Option<String>,
    pub text: String,
    pub status: Option<String>,
    pub historical: bool,
    pub at_ms: u64,
}
#[derive(Debug, Clone)]
pub struct NativeEventPage {
    pub events: Vec<NativeEvent>,
    pub cursor: u64,
    pub gap: bool,
}
#[derive(Default)]
pub(crate) struct Observer {
    pub session: Option<String>,
    pub replaying: bool,
    pub active: bool,
    pub turn: Option<String>,
    pub request: Option<String>,
    events: VecDeque<NativeEvent>,
    cursor: u64,
    serial: u64,
    last_message: Option<(String, String)>,
    completed_turns: HashSet<String>,
    pub gap: bool,
}
impl Observer {
    pub fn bind(&mut self, session: &str, replay: bool) {
        self.session = Some(session.into());
        self.replaying = replay;
        self.active = false;
        self.turn = None;
        self.last_message = None;
    }
    pub fn begin(&mut self, request: &str, text: &str) {
        self.active = true;
        self.replaying = false;
        self.turn = None;
        self.request = Some(request.into());
        self.last_message = None;
        self.message("user", text, None, false);
        self.last_message = None;
    }
    pub fn finish(&mut self) {
        if self.completed_turns.len() >= 256 {
            self.completed_turns.clear();
        }
        if let Some(turn) = &self.turn {
            self.completed_turns.insert(turn.clone());
        }
        self.active = false;
        self.last_message = None;
    }
    pub fn page(&self, after: u64) -> NativeEventPage {
        NativeEventPage {
            events: self
                .events
                .iter()
                .filter(|e| e.cursor > after)
                .cloned()
                .collect(),
            cursor: self.cursor,
            gap: self.gap,
        }
    }
    fn push(&mut self, mut event: NativeEvent) {
        self.cursor = self.cursor.saturating_add(1);
        event.cursor = self.cursor;
        if let Some(i) = self.events.iter().position(|e| e.key == event.key) {
            self.events.remove(i);
        }
        self.events.push_back(event);
        while self.events.len() > 500
            || self.events.iter().map(|e| e.text.len()).sum::<usize>() > 1024 * 1024
        {
            self.events.pop_front();
            self.gap = true;
        }
    }
    fn event(&self, key: String, kind: &str, text: String, item: Option<String>) -> NativeEvent {
        NativeEvent {
            cursor: 0,
            key,
            request_id: if self.replaying {
                None
            } else {
                self.request.clone()
            },
            session: self.session.clone().unwrap_or_default(),
            turn: self.turn.clone(),
            item,
            kind: kind.into(),
            role: None,
            text,
            status: None,
            historical: self.replaying,
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }
    fn message(&mut self, role: &str, text: &str, item: Option<&str>, append: bool) {
        if text.is_empty() {
            return;
        }
        let key = if let Some(item) = item {
            format!("item:{}:{item}", self.turn.as_deref().unwrap_or("history"))
        } else if append && self.last_message.as_ref().is_some_and(|(_, r)| r == role) {
            self.last_message.as_ref().unwrap().0.clone()
        } else {
            self.serial += 1;
            format!(
                "{}:{}:{}:{role}",
                if self.replaying {
                    "history"
                } else {
                    "observed"
                },
                self.request.as_deref().unwrap_or("load"),
                self.serial
            )
        };
        let old = self.events.iter().find(|e| e.key == key).cloned();
        let mut event = self.event(
            key.clone(),
            "message",
            String::new(),
            item.map(str::to_owned),
        );
        event.role = Some(role.into());
        if role == "context" {
            event.kind = "context".into();
        }
        if let Some(old) = old {
            if append {
                event.text = old.text;
            }
            event.at_ms = old.at_ms;
        }
        let room = (512 * 1024usize).saturating_sub(event.text.len());
        if text.len() > room {
            self.gap = true;
        }
        event.text.push_str(&crate::rpc::bounded(text, room));
        self.last_message = Some((key, role.into()));
        self.push(event);
    }
    /// False means a bound transport frame is for a different session/turn.
    pub fn accepts(&self, provider: AgentProvider, p: &Value) -> bool {
        let Some(session) = &self.session else {
            return true;
        };
        let id = if provider == AgentProvider::Codex {
            p["threadId"]
                .as_str()
                .or_else(|| p["thread"]["id"].as_str())
        } else {
            p["sessionId"].as_str()
        };
        if id != Some(session.as_str()) {
            return false;
        }
        if provider == AgentProvider::Codex {
            let turn = p["turnId"].as_str().or_else(|| p["turn"]["id"].as_str());
            if turn.is_some() && (!self.active || self.turn.is_none()) && !self.replaying {
                return false;
            }
            if turn.is_some_and(|t| self.completed_turns.contains(t)) {
                return false;
            }
            if let (Some(expected), Some(actual)) = (&self.turn, turn)
                && expected != actual
            {
                return false;
            }
        }
        true
    }
    pub fn observe(
        &mut self,
        provider: AgentProvider,
        method: &str,
        p: &Value,
        scrub: impl Fn(&str) -> String,
    ) {
        if self.session.is_none() || !self.accepts(provider, p) {
            return;
        }
        if provider == AgentProvider::Codex && method == "turn/started" {
            return; // Only the correlated turn/start response binds a new turn.
        }
        if !self.active && !self.replaying {
            return;
        }
        if provider == AgentProvider::Codex && method == "item/agentMessage/delta" {
            if self.turn.is_some() {
                self.message(
                    "assistant",
                    &scrub(p["delta"].as_str().unwrap_or("")),
                    p["itemId"].as_str(),
                    true,
                );
            }
            return;
        }
        if provider == AgentProvider::Codex && matches!(method, "item/started" | "item/completed") {
            let item = &p["item"];
            let kind = item["type"].as_str().unwrap_or("");
            if kind == "agentMessage" && method == "item/completed" {
                self.message(
                    "assistant",
                    &scrub(item["text"].as_str().unwrap_or("")),
                    item["id"].as_str(),
                    false,
                );
                return;
            }
            if matches!(kind, "agentMessage" | "userMessage" | "reasoning") {
                return;
            }
            let Some(id) = item["id"].as_str() else {
                return;
            };
            self.last_message = None;
            let mut event = self.event(
                format!("tool:{}:{id}", self.turn.as_deref().unwrap_or("")),
                "tool",
                scrub(
                    item["command"]
                        .as_str()
                        .or_else(|| item["tool"].as_str())
                        .unwrap_or(kind),
                ),
                Some(id.into()),
            );
            event.status = Some(
                match item["status"].as_str() {
                    Some("inProgress") => "running",
                    Some(status) => status,
                    None if method.ends_with("completed") => "completed",
                    None => "running",
                }
                .into(),
            );
            self.push(event);
            return;
        }
        if method != "session/update" {
            return;
        }
        let u = &p["update"];
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => self.message(
                "assistant",
                &scrub(u["content"]["text"].as_str().unwrap_or("")),
                None,
                true,
            ),
            "user_message_chunk" if self.replaying => {
                self.last_message = None;
                let text = scrub(u["content"]["text"].as_str().unwrap_or(""));
                self.message(
                    if text.starts_with("<resource uri=\"rho://connection-context\"") {
                        "context"
                    } else {
                        "user"
                    },
                    &text,
                    None,
                    false,
                );
                self.last_message = None;
            }
            "tool_call" | "tool_call_update" => {
                let Some(id) = u["toolCallId"].as_str() else {
                    return;
                };
                self.last_message = None;
                let key = format!(
                    "tool:{}:{id}",
                    if self.replaying {
                        "history"
                    } else {
                        self.request.as_deref().unwrap_or("live")
                    }
                );
                let old = self.events.iter().find(|e| e.key == key).cloned();
                let title = u["title"]
                    .as_str()
                    .map(&scrub)
                    .or_else(|| old.as_ref().map(|e| e.text.clone()))
                    .unwrap_or_else(|| "Tool activity".into());
                let mut event = self.event(key, "tool", title, Some(id.into()));
                event.status = u["status"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| old.as_ref().and_then(|e| e.status.clone()));
                if let Some(old) = old {
                    event.at_ms = old.at_ms;
                }
                self.push(event);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn observer_rejects_other_sessions_and_completed_codex_turns() {
        let mut o = Observer::default();
        o.bind("s", false);
        o.begin("r", "hello");
        assert!(!o.accepts(AgentProvider::Kimi, &json!({"sessionId":"other"})));
        o.turn = Some("t1".into());
        o.finish();
        o.begin("r2", "next");
        assert!(!o.accepts(AgentProvider::Codex, &json!({"threadId":"s","turnId":"t1"})));
    }
    #[test]
    fn observer_coalesces_delta_with_stable_key_and_tool_boundary() {
        let mut o = Observer::default();
        o.bind("s", false);
        o.begin("r", "hello");
        for text in ["a", "b"] {
            o.observe(AgentProvider::Kimi,"session/update",&json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"text":text}}}),str::to_owned);
        }
        let page = o.page(0);
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[1].text, "ab");
        let cursor = page.cursor;
        o.observe(AgentProvider::Kimi,"session/update",&json!({"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"native-tool","title":"Read"}}),str::to_owned);
        o.observe(AgentProvider::Kimi,"session/update",&json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"done"}}}),str::to_owned);
        assert_eq!(o.page(cursor).events.len(), 2);
        assert_eq!(o.page(0).events.len(), 4);
    }
}

#[cfg(test)]
mod native_status_test {
    use super::*;
    #[test]
    fn completed_notification_preserves_native_tool_failure() {
        let mut o = Observer::default();
        o.bind("thread", false);
        o.begin("request", "hello");
        o.turn = Some("turn".into());
        o.observe(AgentProvider::Codex,"item/completed",&serde_json::json!({"threadId":"thread","turnId":"turn","item":{"id":"item","type":"commandExecution","command":"fixture","status":"failed"}}),str::to_owned);
        assert_eq!(
            o.page(0).events.last().unwrap().status.as_deref(),
            Some("failed")
        );
    }
}
