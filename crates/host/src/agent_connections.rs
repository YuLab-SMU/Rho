//! Host-issued identities for managed MCP connections. Never model-supplied.
use rho_contract::{CallContext, CallerIdentity, CallerKind};
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone)]
pub struct AgentMcpIdentity {
    pub project: String,
    pub context: CallContext,
    valid: Arc<AtomicBool>,
}
impl AgentMcpIdentity {
    pub fn is_valid(&self) -> bool {
        self.valid.load(Ordering::Acquire)
    }
}

#[derive(Default)]
pub struct AgentMcpConnections {
    entries: Mutex<HashMap<String, AgentMcpIdentity>>,
}

/// A native attachment holds its lease even while an accepted prompt is quiet.
pub(crate) struct AgentMcpLease {
    pub token: String,
    identity: AgentMcpIdentity,
    registry: Weak<AgentMcpConnections>,
}
impl AgentMcpLease {
    pub fn revoke(&self) {
        self.identity.valid.store(false, Ordering::Release);
        if let Some(registry) = self.registry.upgrade() {
            registry.entries.lock().unwrap().remove(&self.token);
        }
    }
}
impl rho_agent_native::NativeConnectionLease for AgentMcpLease {
    fn revoke(&self) {
        AgentMcpLease::revoke(self);
    }
}
impl Drop for AgentMcpLease {
    fn drop(&mut self) {
        self.revoke();
    }
}

impl AgentMcpConnections {
    pub(crate) fn issue(
        self: &Arc<Self>,
        project: &str,
        context: &CallContext,
        kind: &str,
        id: &str,
        _created_generation: u64,
        legacy_caller: bool,
    ) -> AgentMcpLease {
        let mut context = context.clone();
        context.principal = Some(context.principal().clone());
        context.caller = CallerIdentity {
            kind: CallerKind::Agent,
            id: if legacy_caller {
                "local-mcp".into()
            } else {
                format!("{kind}:{id}")
            },
        };
        // Transport identity is independent of the UI controller generation:
        // an idle takeover can retain the same owned native connection.
        context.connection_id = format!("{kind}:{id}:{}", uuid::Uuid::new_v4());
        let identity = AgentMcpIdentity {
            project: project.into(),
            context,
            valid: Arc::new(AtomicBool::new(true)),
        };
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.entries
            .lock()
            .unwrap()
            .insert(token.clone(), identity.clone());
        AgentMcpLease {
            token,
            identity,
            registry: Arc::downgrade(self),
        }
    }
    pub fn resolve(&self, token: &str) -> Option<AgentMcpIdentity> {
        self.entries
            .lock()
            .ok()?
            .get(token)
            .filter(|entry| entry.is_valid())
            .cloned()
    }
    pub fn revoke_all(&self) {
        let mut entries = self.entries.lock().unwrap();
        for entry in entries.values() {
            entry.valid.store(false, Ordering::Release);
        }
        entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachment_replacement_preserves_caller_but_revokes_old_transport() {
        let connections = Arc::new(AgentMcpConnections::default());
        let context = crate::NextHost::local_context();
        let a = connections.issue("/project", &context, "task", "one", 1, false);
        let b = connections.issue("/project", &context, "task", "two", 1, false);
        let original = connections.resolve(&a.token).unwrap();
        assert_ne!(
            original.context.caller,
            connections.resolve(&b.token).unwrap().context.caller
        );
        a.revoke();
        assert!(!original.is_valid());
        assert!(connections.resolve(&a.token).is_none());
        let resumed = connections.issue("/project", &context, "task", "one", 2, false);
        let current = connections.resolve(&resumed.token).unwrap();
        assert_eq!(original.context.caller, current.context.caller);
        assert_eq!(current.context.principal(), context.principal());
        assert_ne!(
            original.context.connection_id,
            current.context.connection_id
        );
        assert!(connections.resolve(&b.token).is_some());
        drop(resumed);
        assert!(!current.is_valid());
        let legacy = connections.issue("/project", &context, "task", "old", 2, true);
        assert_eq!(
            connections
                .resolve(&legacy.token)
                .unwrap()
                .context
                .caller
                .id,
            "local-mcp"
        );
    }
}
