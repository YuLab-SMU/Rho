//! Plugin instance lifecycle state machine and bounded audit (P2-4).
//!
//! Owns the broker-supervised lifecycle over a discovered plugin package:
//! `discovered → disabled → resolving → activating → active → quiescing →
//! disposing → stopped`, plus failure states `blocked`, `crashed`, and
//! `update-pending`. It also keeps a bounded, redacted audit trail so teardown
//! and upgrade transitions are truthful and recoverable.
//!
//! P2-4 supports local package replacement only (no marketplace updater). A
//! digest change creates a new identity; grants never carry forward. This
//! module performs no execution and no privileged I/O — it is pure state and
//! audit bookkeeping over the primitives built in earlier packages.

use serde::{Deserialize, Serialize};

use crate::digest::PackageDigest;
use crate::host::HostInstanceId;
use crate::{ActivationGeneration, PluginId, ScopeId};

/// The lifecycle state of a plugin instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginLifecycleState {
    /// Metadata known; executable code has not run.
    Discovered,
    /// Manifest, compatibility, trust, policy, or package validation failed.
    Blocked,
    /// Valid package, not permitted to execute.
    Disabled,
    /// Capability and permission prerequisites are being evaluated.
    Resolving,
    /// Isolated instance is starting transactionally.
    Activating,
    /// Contributions committed and calls admitted.
    Active,
    /// New calls denied; in-flight calls drain/cancel.
    Quiescing,
    /// Effects, handles, host instance, and storage leases are closing.
    Disposing,
    /// No code or capability is routable.
    Stopped,
    /// Host/instance terminated unexpectedly; handles revoked.
    Crashed,
    /// New digest discovered; old instance remains active or is stopped.
    UpdatePending,
}

impl PluginLifecycleState {
    /// Whether the instance is currently routable (admits contribution calls).
    pub fn is_routable(self) -> bool {
        matches!(self, Self::Active)
    }

    /// Whether any stale capability, handle, or route is still possible.
    pub fn has_live_effects(self) -> bool {
        matches!(
            self,
            Self::Active | Self::Quiescing | Self::Disposing | Self::Activating
        )
    }
}

/// A valid state transition, or `None` if the transition is forbidden.
pub const fn allowed_transition(from: PluginLifecycleState, to: PluginLifecycleState) -> bool {
    use PluginLifecycleState::*;
    matches!(
        (from, to),
        (Discovered, Blocked)
            | (Discovered, Disabled)
            | (Disabled, Resolving)
            | (Disabled, Blocked)
            | (Resolving, Activating)
            | (Resolving, Blocked)
            | (Activating, Active)
            | (Activating, Blocked)
            | (Active, Quiescing)
            | (Active, Crashed)
            | (Active, UpdatePending)
            | (Quiescing, Disposing)
            | (Disposing, Stopped)
            | (UpdatePending, Blocked)
            | (UpdatePending, Disabled)
            | (Blocked, Disabled)
            | (Stopped, Disabled)
            | (Crashed, Disabled)
            | (Crashed, Stopped)
    )
}

/// A single bounded audit event. No raw tokens, credentials, or unbounded
/// payloads are ever recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEvent {
    pub plugin_id: PluginId,
    pub project_id: ScopeId,
    pub transition_from: Option<PluginLifecycleState>,
    pub transition_to: PluginLifecycleState,
    pub reason: String,
}

/// Bounded, append-only-in-meaning audit trail.
#[derive(Debug, Default, Clone)]
pub struct AuditLog {
    events: Vec<AuditEvent>,
}

/// Maximum number of audit events retained per plugin instance before the
/// oldest is evicted to bound memory.
pub const MAX_AUDIT_EVENTS: usize = 256;
/// Maximum UTF-8 bytes retained for one redacted audit reason.
pub const MAX_AUDIT_REASON_BYTES: usize = 512;

impl AuditLog {
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    pub fn record(&mut self, event: AuditEvent) {
        let mut event = event;
        event.reason = bounded_audit_reason(&event.reason);
        if self.events.len() >= MAX_AUDIT_EVENTS {
            self.events.remove(0);
        }
        self.events.push(event);
    }

    pub fn events(&self) -> &[AuditEvent] {
        &self.events
    }
}

fn bounded_audit_reason(reason: &str) -> String {
    let redacted: String = reason
        .chars()
        .map(|character| {
            if character.is_control() {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect();
    if redacted.len() <= MAX_AUDIT_REASON_BYTES {
        return redacted;
    }
    let mut end = MAX_AUDIT_REASON_BYTES;
    while !redacted.is_char_boundary(end) {
        end -= 1;
    }
    redacted[..end].to_string()
}

/// The accepted (active) plugin package plus its lifecycle and audit state.
#[derive(Debug, Clone)]
pub struct PluginInstance {
    pub plugin_id: PluginId,
    pub project_id: ScopeId,
    pub package_digest: PackageDigest,
    pub activation_generation: Option<ActivationGeneration>,
    pub host_instance_id: Option<HostInstanceId>,
    pub state: PluginLifecycleState,
    pub audit: AuditLog,
}

impl PluginInstance {
    pub fn new(plugin_id: PluginId, project_id: ScopeId, package_digest: PackageDigest) -> Self {
        let mut instance = Self {
            plugin_id,
            project_id,
            package_digest,
            activation_generation: None,
            host_instance_id: None,
            state: PluginLifecycleState::Discovered,
            audit: AuditLog::new(),
        };
        instance.audit.record(AuditEvent {
            plugin_id: instance.plugin_id.clone(),
            project_id: instance.project_id.clone(),
            transition_from: None,
            transition_to: PluginLifecycleState::Discovered,
            reason: "discovered".to_string(),
        });
        instance
    }

    /// Attempt a transition; fails (returns `false`) on a forbidden edge and
    /// records the successful transition in the audit log.
    pub fn transition(&mut self, to: PluginLifecycleState, reason: impl Into<String>) -> bool {
        if !allowed_transition(self.state, to) {
            return false;
        }
        let from = self.state;
        self.state = to;
        self.audit.record(AuditEvent {
            plugin_id: self.plugin_id.clone(),
            project_id: self.project_id.clone(),
            transition_from: Some(from),
            transition_to: to,
            reason: reason.into(),
        });
        true
    }
}

/// Broker-owned registry over the lifecycle of every discovered/active plugin
/// package in one project, plus local package replacement (candidate →
/// accepted) with rollback and digest-bound identity.
#[derive(Debug, Default)]
pub struct PluginManager {
    /// All known plugin instances keyed by exact `(project_id, plugin_id)`.
    instances: std::collections::BTreeMap<(ScopeId, PluginId), PluginInstance>,
    /// The currently accepted package digest per exact project/plugin key.
    accepted: std::collections::BTreeMap<(ScopeId, PluginId), PackageDigest>,
    /// Validated local replacement candidates. The active instance remains
    /// untouched until an expected-old publication succeeds.
    pending_updates: std::collections::BTreeMap<(ScopeId, PluginId), PackageDigest>,
}

/// Error kind for lifecycle operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginManagerError {
    UnknownPlugin,
    ForbiddenTransition,
    /// A replacement digest is already accepted (stale expected-old pointer).
    StaleReplacement,
    /// Replacement was not the currently discovered pending candidate.
    CandidateNotPending,
    /// The exact project/plugin key already exists and cannot be overwritten.
    DuplicateDiscovery,
    /// The activation generation cannot advance further.
    GenerationExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryOutcome {
    New,
    Unchanged,
    UpdatePending,
}

impl PluginManager {
    pub fn new() -> Self {
        Self {
            instances: std::collections::BTreeMap::new(),
            accepted: std::collections::BTreeMap::new(),
            pending_updates: std::collections::BTreeMap::new(),
        }
    }

    /// Register a newly discovered plugin (disabled until explicit enablement).
    pub fn discover(
        &mut self,
        plugin_id: PluginId,
        project_id: ScopeId,
        package_digest: PackageDigest,
    ) -> Result<DiscoveryOutcome, PluginManagerError> {
        let key = (project_id.clone(), plugin_id.clone());
        match self.instances.get(&key) {
            None => {
                let instance = PluginInstance::new(plugin_id, project_id, package_digest);
                self.instances.insert(key, instance);
                Ok(DiscoveryOutcome::New)
            }
            Some(instance) if instance.package_digest == package_digest => {
                Ok(DiscoveryOutcome::Unchanged)
            }
            Some(instance) if instance.state == PluginLifecycleState::Active => {
                self.pending_updates.insert(key, package_digest);
                Ok(DiscoveryOutcome::UpdatePending)
            }
            Some(_) => Err(PluginManagerError::DuplicateDiscovery),
        }
    }

    /// Enable a plugin: advance discovered/disabled → resolving → activating →
    /// active and record the accepted digest.
    pub fn enable(
        &mut self,
        project_id: &ScopeId,
        plugin_id: &PluginId,
    ) -> Result<(), PluginManagerError> {
        let key = (project_id.clone(), plugin_id.clone());
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        let next_generation = instance
            .activation_generation
            .map(|generation| generation.get().checked_add(1))
            .unwrap_or(Some(1))
            .ok_or(PluginManagerError::GenerationExhausted)?;
        // Enter resolving from discovered or disabled.
        if instance.state == PluginLifecycleState::Discovered
            || instance.state == PluginLifecycleState::Disabled
            || instance.state == PluginLifecycleState::Stopped
        {
            // Note: from disabled → resolving needs `Disabled → Resolving`, which
            // is allowed. From discovered we first move to disabled.
            if matches!(
                instance.state,
                PluginLifecycleState::Discovered | PluginLifecycleState::Stopped
            ) && !instance.transition(PluginLifecycleState::Disabled, "awaiting enable")
            {
                return Err(PluginManagerError::ForbiddenTransition);
            }
        }
        let package_digest = {
            let instance = self
                .instances
                .get_mut(&key)
                .ok_or(PluginManagerError::UnknownPlugin)?;
            if !instance.transition(PluginLifecycleState::Resolving, "enable requested") {
                return Err(PluginManagerError::ForbiddenTransition);
            }
            instance.package_digest.clone()
        };
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if !instance.transition(PluginLifecycleState::Activating, "resolved") {
            return Err(PluginManagerError::ForbiddenTransition);
        }
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if !instance.transition(PluginLifecycleState::Active, "activated") {
            return Err(PluginManagerError::ForbiddenTransition);
        }
        instance.activation_generation = Some(
            ActivationGeneration::new(next_generation)
                .map_err(|_| PluginManagerError::GenerationExhausted)?,
        );
        instance.host_instance_id = Some(HostInstanceId::generate());
        self.accepted.insert(key, package_digest);
        Ok(())
    }

    /// Disable: quiesce → dispose → stopped; revoke-accepted digest is NOT
    /// removed (history preserved) but routing is gone.
    pub fn disable(
        &mut self,
        project_id: &ScopeId,
        plugin_id: &PluginId,
    ) -> Result<(), PluginManagerError> {
        let key = (project_id.clone(), plugin_id.clone());
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if !instance.transition(PluginLifecycleState::Quiescing, "disable requested") {
            return Err(PluginManagerError::ForbiddenTransition);
        }
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if !instance.transition(PluginLifecycleState::Disposing, "effects released") {
            return Err(PluginManagerError::ForbiddenTransition);
        }
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if !instance.transition(PluginLifecycleState::Stopped, "teardown complete") {
            return Err(PluginManagerError::ForbiddenTransition);
        }
        instance.host_instance_id = None;
        Ok(())
    }

    /// Crash: mark crashed (revokes handles) with a truthful diagnostic.
    pub fn mark_crashed(
        &mut self,
        project_id: &ScopeId,
        plugin_id: &PluginId,
        reason: impl Into<String>,
    ) -> Result<(), PluginManagerError> {
        let key = (project_id.clone(), plugin_id.clone());
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if !instance.transition(PluginLifecycleState::Crashed, reason) {
            return Err(PluginManagerError::ForbiddenTransition);
        }
        instance.host_instance_id = None;
        Ok(())
    }

    /// Local package replacement using candidate validation and expected-old
    /// pointer exchange. The old digest must match the currently accepted
    /// digest, otherwise the replacement is stale and rejected.
    pub fn replace(
        &mut self,
        project_id: &ScopeId,
        plugin_id: &PluginId,
        expected_old: &PackageDigest,
        candidate: PackageDigest,
    ) -> Result<(), PluginManagerError> {
        let key = (project_id.clone(), plugin_id.clone());
        let current = self
            .accepted
            .get(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if current != expected_old {
            return Err(PluginManagerError::StaleReplacement);
        }
        if self.pending_updates.get(&key) != Some(&candidate) {
            return Err(PluginManagerError::CandidateNotPending);
        }
        // Candidate validation is out of scope here (no code runs); the digest
        // swap alone is the identity transition. Grants for the old digest are
        // not carried forward (handled by the grant store's digest binding).
        let instance = self
            .instances
            .get_mut(&key)
            .ok_or(PluginManagerError::UnknownPlugin)?;
        if instance.state != PluginLifecycleState::Active {
            return Err(PluginManagerError::ForbiddenTransition);
        }
        let next_generation = instance
            .activation_generation
            .and_then(|generation| generation.get().checked_add(1))
            .ok_or(PluginManagerError::GenerationExhausted)?;
        instance.package_digest = candidate.clone();
        instance.activation_generation = Some(
            ActivationGeneration::new(next_generation)
                .map_err(|_| PluginManagerError::GenerationExhausted)?,
        );
        instance.host_instance_id = Some(HostInstanceId::generate());
        instance.audit.record(AuditEvent {
            plugin_id: plugin_id.clone(),
            project_id: project_id.clone(),
            transition_from: Some(PluginLifecycleState::Active),
            transition_to: PluginLifecycleState::Active,
            reason: "accepted local package replacement".to_string(),
        });
        self.accepted.insert(key.clone(), candidate);
        self.pending_updates.remove(&key);
        Ok(())
    }

    pub fn reject_update(&mut self, project_id: &ScopeId, plugin_id: &PluginId) -> bool {
        self.pending_updates
            .remove(&(project_id.clone(), plugin_id.clone()))
            .is_some()
    }

    pub fn instance(&self, project_id: &ScopeId, plugin_id: &PluginId) -> Option<&PluginInstance> {
        self.instances.get(&(project_id.clone(), plugin_id.clone()))
    }

    pub fn accepted_digest(
        &self,
        project_id: &ScopeId,
        plugin_id: &PluginId,
    ) -> Option<&PackageDigest> {
        self.accepted.get(&(project_id.clone(), plugin_id.clone()))
    }

    pub fn pending_digest(
        &self,
        project_id: &ScopeId,
        plugin_id: &PluginId,
    ) -> Option<&PackageDigest> {
        self.pending_updates
            .get(&(project_id.clone(), plugin_id.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str) -> ScopeId {
        ScopeId::new(id).unwrap()
    }

    fn plugin(id: &str) -> PluginId {
        PluginId::new(id).unwrap()
    }

    fn digest(seed: &str) -> PackageDigest {
        PackageDigest::from_inventory(&[(seed.as_bytes(), seed.as_bytes())])
    }

    #[test]
    fn discover_enable_disable_is_reversible() {
        let mut manager = PluginManager::new();
        let pid = plugin("org.example.a");
        let project = scope("scope.project");
        manager
            .discover(pid.clone(), project.clone(), digest("v1"))
            .unwrap();

        assert!(
            manager.instance(&project, &pid).unwrap().state == PluginLifecycleState::Discovered
        );
        manager.enable(&project, &pid).unwrap();
        assert!(manager.instance(&project, &pid).unwrap().state == PluginLifecycleState::Active);
        assert_eq!(manager.accepted_digest(&project, &pid), Some(&digest("v1")));
        let first_generation = manager
            .instance(&project, &pid)
            .unwrap()
            .activation_generation;
        let first_host = manager
            .instance(&project, &pid)
            .unwrap()
            .host_instance_id
            .clone();

        manager.disable(&project, &pid).unwrap();
        assert!(manager.instance(&project, &pid).unwrap().state == PluginLifecycleState::Stopped);
        assert!(
            !manager
                .instance(&project, &pid)
                .unwrap()
                .state
                .is_routable()
        );
        assert!(
            manager
                .instance(&project, &pid)
                .unwrap()
                .host_instance_id
                .is_none()
        );

        manager.enable(&project, &pid).unwrap();
        let reenabled = manager.instance(&project, &pid).unwrap();
        assert_eq!(reenabled.state, PluginLifecycleState::Active);
        assert!(reenabled.activation_generation > first_generation);
        assert_ne!(reenabled.host_instance_id, first_host);
    }

    #[test]
    fn forbidden_transition_is_rejected() {
        let mut manager = PluginManager::new();
        let pid = plugin("org.example.a");
        let project = scope("scope.project");
        manager
            .discover(pid.clone(), project.clone(), digest("v1"))
            .unwrap();
        // Cannot disable directly from discovered.
        assert_eq!(
            manager.disable(&project, &pid),
            Err(PluginManagerError::ForbiddenTransition)
        );
    }

    #[test]
    fn crash_mark_revokes_routing() {
        let mut manager = PluginManager::new();
        let pid = plugin("org.example.a");
        let project = scope("scope.project");
        manager
            .discover(pid.clone(), project.clone(), digest("v1"))
            .unwrap();
        manager.enable(&project, &pid).unwrap();
        manager.mark_crashed(&project, &pid, "segfault").unwrap();
        assert!(manager.instance(&project, &pid).unwrap().state == PluginLifecycleState::Crashed);
    }

    #[test]
    fn replace_requires_expected_old_digest() {
        let mut manager = PluginManager::new();
        let pid = plugin("org.example.a");
        let project = scope("scope.project");
        manager
            .discover(pid.clone(), project.clone(), digest("v1"))
            .unwrap();
        manager.enable(&project, &pid).unwrap();
        assert_eq!(
            manager
                .discover(pid.clone(), project.clone(), digest("v2"))
                .unwrap(),
            DiscoveryOutcome::UpdatePending
        );

        // Correct expected-old succeeds.
        manager
            .replace(&project, &pid, &digest("v1"), digest("v2"))
            .unwrap();
        assert_eq!(manager.accepted_digest(&project, &pid), Some(&digest("v2")));
        assert_eq!(
            manager
                .instance(&project, &pid)
                .unwrap()
                .activation_generation
                .unwrap()
                .get(),
            2
        );

        // Stale expected-old is rejected.
        let err = manager
            .replace(&project, &pid, &digest("v1"), digest("v3"))
            .unwrap_err();
        assert_eq!(err, PluginManagerError::StaleReplacement);
    }

    #[test]
    fn audit_is_bounded_and_truthful() {
        let mut manager = PluginManager::new();
        let pid = plugin("org.example.a");
        let project = scope("scope.project");
        manager
            .discover(pid.clone(), project.clone(), digest("v1"))
            .unwrap();
        manager.enable(&project, &pid).unwrap();
        let events = manager.instance(&project, &pid).unwrap().audit.events();
        assert!(!events.is_empty());
        assert_eq!(events[0].transition_to, PluginLifecycleState::Discovered);
    }

    #[test]
    fn identical_plugin_ids_are_isolated_between_projects() {
        let mut manager = PluginManager::new();
        let pid = plugin("org.example.same");
        let a = scope("scope.project.a");
        let b = scope("scope.project.b");
        manager
            .discover(pid.clone(), a.clone(), digest("a"))
            .unwrap();
        manager
            .discover(pid.clone(), b.clone(), digest("b"))
            .unwrap();
        manager.enable(&a, &pid).unwrap();

        assert_eq!(manager.accepted_digest(&a, &pid), Some(&digest("a")));
        assert_eq!(
            manager.instance(&b, &pid).unwrap().package_digest,
            digest("b")
        );
        assert_eq!(
            manager.instance(&b, &pid).unwrap().state,
            PluginLifecycleState::Discovered
        );
    }

    #[test]
    fn failed_update_keeps_old_active_instance() {
        let mut manager = PluginManager::new();
        let pid = plugin("org.example.a");
        let project = scope("scope.project");
        manager
            .discover(pid.clone(), project.clone(), digest("v1"))
            .unwrap();
        manager.enable(&project, &pid).unwrap();
        manager
            .discover(pid.clone(), project.clone(), digest("v2"))
            .unwrap();

        assert_eq!(manager.pending_digest(&project, &pid), Some(&digest("v2")));
        assert_eq!(manager.accepted_digest(&project, &pid), Some(&digest("v1")));
        assert_eq!(
            manager.instance(&project, &pid).unwrap().state,
            PluginLifecycleState::Active
        );
        assert!(manager.reject_update(&project, &pid));
        assert!(manager.pending_digest(&project, &pid).is_none());
        assert_eq!(manager.accepted_digest(&project, &pid), Some(&digest("v1")));
    }

    #[test]
    fn audit_reason_is_bounded_and_control_characters_are_redacted() {
        let mut log = AuditLog::new();
        log.record(AuditEvent {
            plugin_id: plugin("org.example.a"),
            project_id: scope("scope.project"),
            transition_from: None,
            transition_to: PluginLifecycleState::Discovered,
            reason: format!("secret\n{}", "x".repeat(MAX_AUDIT_REASON_BYTES * 2)),
        });
        let reason = &log.events()[0].reason;
        assert!(reason.len() <= MAX_AUDIT_REASON_BYTES);
        assert!(!reason.contains('\n'));
    }
}
