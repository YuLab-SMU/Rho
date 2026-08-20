//! Declarative, reversible third-party UI/capability contributions (P2-3).
//!
//! A plugin contributes only *declarative metadata* — a bounded label, a
//! purpose string, and a typed kind. It can never provide an executable
//! handler, DOM, or renderer: the trusted Rho shell owns all rendering,
//! focus, placement, and lifecycle. This makes spoofing trusted approval,
//! credential, update, or security surfaces impossible by construction.
//!
//! Contributions are project-scoped and reversible. This module performs no
//! execution and no privileged I/O; it is pure registry bookkeeping.

use serde::{Deserialize, Serialize};

use crate::digest::PackageDigest;
use crate::host::HostInstanceId;
use crate::{ActivationGeneration, CapabilityId, PluginId, ScopeId};

pub const MAX_CONTRIBUTIONS_PER_PROJECT: usize = 256;
pub const MAX_CONTRIBUTION_LABEL_BYTES: usize = 256;
pub const MAX_CONTRIBUTION_PURPOSE_BYTES: usize = 2048;

/// The narrow, denied-by-default contribution surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionKind {
    /// `ui.command.*` — a named command the trusted shell renders.
    Command,
    /// `ui.viewer.*` — a controlled viewer the trusted shell hosts.
    Viewer,
    /// `tool.*` — a bounded tool with schema honored by the broker façade.
    Tool,
    /// `skill.*` — declarative content only; never executable.
    Skill,
}

impl ContributionKind {
    pub fn parse(value: &str) -> Option<Self> {
        if let Some(rest) = value.strip_prefix("ui.command.") {
            return (!rest.is_empty()).then_some(Self::Command);
        }
        if let Some(rest) = value.strip_prefix("ui.viewer.") {
            return (!rest.is_empty()).then_some(Self::Viewer);
        }
        if let Some(rest) = value.strip_prefix("tool.") {
            return (!rest.is_empty()).then_some(Self::Tool);
        }
        if let Some(rest) = value.strip_prefix("skill.") {
            return (!rest.is_empty()).then_some(Self::Skill);
        }
        None
    }
}

/// A single declarative contribution. The label and purpose are untrusted
/// plugin text; they are rendered by the trusted shell with origin tagging and
/// never treated as system consequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contribution {
    pub capability: CapabilityId,
    pub kind: ContributionKind,
    pub label: String,
    pub purpose: String,
}

impl Contribution {
    pub fn new(
        capability: CapabilityId,
        kind: ContributionKind,
        label: impl Into<String>,
        purpose: impl Into<String>,
    ) -> Self {
        Self {
            capability,
            kind,
            label: label.into(),
            purpose: purpose.into(),
        }
    }

    fn is_valid(&self) -> bool {
        ContributionKind::parse(self.capability.as_str()) == Some(self.kind)
            && !self.label.is_empty()
            && self.label.len() <= MAX_CONTRIBUTION_LABEL_BYTES
            && !self.purpose.is_empty()
            && self.purpose.len() <= MAX_CONTRIBUTION_PURPOSE_BYTES
            && !self.label.chars().any(char::is_control)
            && !self.purpose.chars().any(char::is_control)
    }
}

/// A committed contribution bound to a plugin instance, package digest, and
/// project. Cross-project reuse is impossible because the project id is part
/// of the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContributionRecord {
    pub contribution: Contribution,
    pub plugin_id: PluginId,
    pub package_digest: PackageDigest,
    pub project_id: ScopeId,
    pub activation_generation: ActivationGeneration,
    pub host_instance_id: HostInstanceId,
}

/// Reversible, project-scoped contribution store.
#[derive(Debug, Default)]
pub struct ContributionStore {
    /// Keyed by `(project_id, capability)` so projects A and B are isolated.
    records: std::collections::BTreeMap<(ScopeId, CapabilityId), ContributionRecord>,
}

/// Error when registering or removing a contribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionError {
    /// A contribution with the same capability is already registered in this
    /// project; fail closed rather than silently overwrite.
    Duplicate,
    /// The contribution was not found for removal.
    Unknown,
    /// The project id does not match the record (cross-project tampering).
    WrongProject,
    /// Plugin/digest ownership does not match the registration owner.
    WrongOwner,
    /// Activation generation is stale.
    StaleGeneration,
    /// Host instance is stale or foreign.
    WrongHostSession,
    /// Declarative contribution metadata is malformed or mismatched.
    Invalid,
    /// Project contribution budget is exhausted.
    LimitExceeded,
}

impl ContributionStore {
    pub fn new() -> Self {
        Self {
            records: std::collections::BTreeMap::new(),
        }
    }

    /// Register a contribution for `project_id`. Fails on duplicate key.
    pub fn register(
        &mut self,
        project_id: ScopeId,
        plugin_id: PluginId,
        package_digest: PackageDigest,
        activation_generation: ActivationGeneration,
        host_instance_id: HostInstanceId,
        contribution: Contribution,
    ) -> Result<(), ContributionError> {
        if !contribution.is_valid() {
            return Err(ContributionError::Invalid);
        }
        if self
            .records
            .keys()
            .filter(|(project, _)| project == &project_id)
            .count()
            >= MAX_CONTRIBUTIONS_PER_PROJECT
        {
            return Err(ContributionError::LimitExceeded);
        }
        let key = (project_id.clone(), contribution.capability.clone());
        if self.records.contains_key(&key) {
            return Err(ContributionError::Duplicate);
        }
        self.records.insert(
            key,
            ContributionRecord {
                contribution,
                plugin_id,
                package_digest,
                project_id,
                activation_generation,
                host_instance_id,
            },
        );
        Ok(())
    }

    /// Remove a contribution. The caller must supply the exact project id; a
    /// mismatch is a cross-project tampering failure and is reported as such.
    pub fn remove(
        &mut self,
        project_id: &ScopeId,
        capability: &CapabilityId,
        plugin_id: &PluginId,
        package_digest: &PackageDigest,
        activation_generation: ActivationGeneration,
        host_instance_id: &HostInstanceId,
    ) -> Result<(), ContributionError> {
        let key = (project_id.clone(), capability.clone());
        match self.records.get(&key) {
            Some(record)
                if &record.plugin_id != plugin_id || &record.package_digest != package_digest =>
            {
                Err(ContributionError::WrongOwner)
            }
            Some(record) if record.activation_generation != activation_generation => {
                Err(ContributionError::StaleGeneration)
            }
            Some(record) if &record.host_instance_id != host_instance_id => {
                Err(ContributionError::WrongHostSession)
            }
            Some(_) => {
                self.records.remove(&key);
                Ok(())
            }
            None => {
                // Distinguish "not present at all" from "present under another
                // project" so the caller can audit cross-project attempts.
                let present_elsewhere = self
                    .records
                    .values()
                    .any(|record| &record.contribution.capability == capability);
                if present_elsewhere {
                    Err(ContributionError::WrongProject)
                } else {
                    Err(ContributionError::Unknown)
                }
            }
        }
    }

    /// List contributions for a single project, in stable key order.
    pub fn list(&self, project_id: &ScopeId) -> Vec<&ContributionRecord> {
        self.records
            .iter()
            .filter(|((_, _), record)| &record.project_id == project_id)
            .map(|(_, record)| record)
            .collect()
    }

    /// Remove every contribution for a project (used at scope teardown).
    pub fn clear_project(&mut self, project_id: &ScopeId) {
        self.records.retain(|(project, _), _| project != project_id);
    }

    /// Remove only the exact plugin instance's registrations during teardown.
    pub fn clear_instance(
        &mut self,
        project_id: &ScopeId,
        plugin_id: &PluginId,
        package_digest: &PackageDigest,
        activation_generation: ActivationGeneration,
        host_instance_id: &HostInstanceId,
    ) {
        self.records.retain(|(project, _), record| {
            project != project_id
                || &record.plugin_id != plugin_id
                || &record.package_digest != package_digest
                || record.activation_generation != activation_generation
                || &record.host_instance_id != host_instance_id
        });
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

    fn capability(id: &str) -> CapabilityId {
        CapabilityId::new(id).unwrap()
    }

    fn digest(seed: &str) -> PackageDigest {
        PackageDigest::from_inventory(&[(seed.as_bytes(), seed.as_bytes())])
    }

    fn generation() -> ActivationGeneration {
        ActivationGeneration::new(1).unwrap()
    }

    fn host() -> HostInstanceId {
        HostInstanceId::new("instance.a").unwrap()
    }

    fn register(
        store: &mut ContributionStore,
        project: &ScopeId,
        plugin_id: &str,
        digest_seed: &str,
        contribution: Contribution,
    ) -> Result<(), ContributionError> {
        store.register(
            project.clone(),
            plugin(plugin_id),
            digest(digest_seed),
            generation(),
            host(),
            contribution,
        )
    }

    #[test]
    fn register_and_list_are_project_scoped() {
        let mut store = ContributionStore::new();
        let a = scope("scope.project.a");
        let b = scope("scope.project.b");
        let record = Contribution::new(
            capability("tool.bio.enrichment"),
            ContributionKind::Tool,
            "Enrichment",
            "Run enrichment analysis",
        );
        register(&mut store, &a, "org.example.a", "pkg", record).unwrap();

        assert_eq!(store.list(&a).len(), 1);
        assert!(store.list(&b).is_empty());
    }

    #[test]
    fn duplicate_is_rejected() {
        let mut store = ContributionStore::new();
        let project = scope("scope.project");
        register(
            &mut store,
            &project,
            "org.example.a",
            "pkg",
            Contribution::new(
                capability("ui.command.run"),
                ContributionKind::Command,
                "Run",
                "Run analysis",
            ),
        )
        .unwrap();
        let err = register(
            &mut store,
            &project,
            "org.example.b",
            "other",
            Contribution::new(
                capability("ui.command.run"),
                ContributionKind::Command,
                "Run again",
                "Duplicate",
            ),
        )
        .unwrap_err();
        assert_eq!(err, ContributionError::Duplicate);
    }

    #[test]
    fn remove_is_reversible_and_guards_cross_project() {
        let mut store = ContributionStore::new();
        let a = scope("scope.project.a");
        let b = scope("scope.project.b");
        register(
            &mut store,
            &a,
            "org.example.a",
            "pkg",
            Contribution::new(
                capability("ui.viewer.table"),
                ContributionKind::Viewer,
                "Table",
                "View a table",
            ),
        )
        .unwrap();

        // Removing under the wrong project must report WrongProject, not Unknown.
        let err = store
            .remove(
                &b,
                &capability("ui.viewer.table"),
                &plugin("org.example.a"),
                &digest("pkg"),
                generation(),
                &host(),
            )
            .unwrap_err();
        assert_eq!(err, ContributionError::WrongProject);

        // Removing under the correct project succeeds and becomes reversible.
        store
            .remove(
                &a,
                &capability("ui.viewer.table"),
                &plugin("org.example.a"),
                &digest("pkg"),
                generation(),
                &host(),
            )
            .unwrap();
        assert!(store.list(&a).is_empty());
    }

    #[test]
    fn clear_project_removes_only_that_project() {
        let mut store = ContributionStore::new();
        let a = scope("scope.project.a");
        let b = scope("scope.project.b");
        for (project, cap) in [(&a, "ui.command.one"), (&b, "ui.command.two")] {
            register(
                &mut store,
                project,
                "org.example.a",
                "pkg",
                Contribution::new(
                    capability(cap),
                    ContributionKind::Command,
                    cap,
                    "Run command",
                ),
            )
            .unwrap();
        }
        store.clear_project(&a);
        assert!(store.list(&a).is_empty());
        assert_eq!(store.list(&b).len(), 1);
    }

    #[test]
    fn contribution_kind_bounds_and_owner_are_enforced() {
        let mut store = ContributionStore::new();
        let project = scope("scope.project");
        let invalid = Contribution::new(
            capability("provider.model.fake"),
            ContributionKind::Tool,
            "Fake",
            "Must not register",
        );
        assert_eq!(
            register(&mut store, &project, "org.example.a", "pkg", invalid),
            Err(ContributionError::Invalid)
        );

        let valid = Contribution::new(
            capability("tool.bio.enrichment"),
            ContributionKind::Tool,
            "Enrichment",
            "Run enrichment",
        );
        register(&mut store, &project, "org.example.a", "pkg", valid).unwrap();
        assert_eq!(
            store.remove(
                &project,
                &capability("tool.bio.enrichment"),
                &plugin("org.example.other"),
                &digest("pkg"),
                generation(),
                &host(),
            ),
            Err(ContributionError::WrongOwner)
        );
    }
}
