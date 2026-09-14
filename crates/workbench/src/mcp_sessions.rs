//! HTTP session ownership covers GET/DELETE as well as MCP RPC handlers.
use rho_mcp::McpRequestIdentity;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct HttpMcpSessions {
    entries: Mutex<HashMap<String, McpRequestIdentity>>,
}
pub(super) struct SessionAccess {
    owner: Arc<HttpMcpSessions>,
    pending: Option<String>,
    existing: Option<String>,
    identity: McpRequestIdentity,
    expired: Vec<String>,
}
impl HttpMcpSessions {
    pub fn enter(
        self: &Arc<Self>,
        identity: McpRequestIdentity,
        session: Option<String>,
    ) -> Result<SessionAccess, &'static str> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "MCP session registry is unavailable")?;
        if let Some(id) = &session {
            if id.len() > 256
                || !entries.get(id).is_some_and(|entry| {
                    entry.project == identity.project && entry.identity == identity.identity
                })
            {
                return Err("MCP session is unavailable to this connection");
            }
        }
        let mut expired = Vec::new();
        entries.retain(|id, entry| {
            let keep = entry.project == identity.project && entry.managed.as_ref().is_none_or(|managed| managed.is_valid());
            if !keep && !id.starts_with("pending:") { expired.push(id.clone()); }
            keep
        });
        let pending = if session.is_none() {
            if entries.len() >= 1024 {
                return Err("MCP session capacity reached");
            }
            let key = format!("pending:{}", uuid::Uuid::new_v4());
            entries.insert(key.clone(), identity.clone());
            Some(key)
        } else {
            None
        };
        Ok(SessionAccess {
            owner: self.clone(),
            pending,
            existing: session,
            identity,
            expired,
        })
    }
}
impl SessionAccess {
    pub fn take_expired(&mut self) -> Vec<String> { std::mem::take(&mut self.expired) }
    pub fn finish(&mut self, session: Option<&str>, deleted: bool) -> Result<(), &'static str> {
        let mut entries = self
            .owner
            .entries
            .lock()
            .map_err(|_| "MCP session registry is unavailable")?;
        if let Some(key) = self.pending.take() {
            entries.remove(&key);
            if let Some(id) = session {
                if id.len() > 256
                    || entries
                        .get(id)
                        .is_some_and(|old| old.identity != self.identity.identity)
                {
                    return Err("MCP session identity conflict");
                }
                entries.insert(id.into(), self.identity.clone());
            }
        }
        if deleted && let Some(id) = &self.existing {
            entries.remove(id);
        }
        Ok(())
    }
}
impl Drop for SessionAccess {
    fn drop(&mut self) {
        if let Some(key) = self.pending.take()
            && let Ok(mut entries) = self.owner.entries.lock()
        {
            entries.remove(&key);
        }
    }
}
