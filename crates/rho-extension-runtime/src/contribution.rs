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
use serde_json::json;

use crate::digest::PackageDigest;
use crate::host::HostInstanceId;
use crate::{ActivationGeneration, BoundedJsonSchema, CapabilityId, PluginId, ScopeId};

pub const MAX_CONTRIBUTIONS_PER_PROJECT: usize = 256;
pub const MAX_CONTRIBUTIONS_PER_PACKAGE: usize = 32;
pub const MAX_CONTRIBUTION_LABEL_BYTES: usize = 128;
pub const MAX_CONTRIBUTION_PURPOSE_BYTES: usize = 1024;
pub const MAX_CONTRIBUTION_MEDIA_TYPES: usize = 16;
pub const MAX_CONTRIBUTION_MEDIA_TYPE_BYTES: usize = 128;
pub const PLUGIN_DETAILS_PANEL_SLOT: &str = "plugin_details";

/// The narrow, denied-by-default contribution surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionKind {
    /// `ui.command.*` — a named command the trusted shell renders.
    Command,
    /// `ui.viewer.*` — a controlled viewer the trusted shell hosts.
    Viewer,
    /// `source.*` — bounded, read-only context returned to trusted Rho code.
    Source,
    /// `tool.*` — a bounded tool with schema honored by the broker façade.
    Tool,
    /// `skill.*` — declarative content only; never executable.
    Skill,
    /// `ui.panel.*` — a document in the one named untrusted-content slot.
    Panel,
}

impl ContributionKind {
    pub fn parse(value: &str) -> Option<Self> {
        if let Some(rest) = value.strip_prefix("ui.command.") {
            return (!rest.is_empty()).then_some(Self::Command);
        }
        if let Some(rest) = value.strip_prefix("ui.viewer.") {
            return (!rest.is_empty()).then_some(Self::Viewer);
        }
        if let Some(rest) = value.strip_prefix("source.") {
            return (!rest.is_empty()).then_some(Self::Source);
        }
        if let Some(rest) = value.strip_prefix("tool.") {
            return (!rest.is_empty()).then_some(Self::Tool);
        }
        if let Some(rest) = value.strip_prefix("skill.") {
            return (!rest.is_empty()).then_some(Self::Skill);
        }
        if let Some(rest) = value.strip_prefix("ui.panel.") {
            return (!rest.is_empty()).then_some(Self::Panel);
        }
        None
    }
}

/// One exact Manifest V2 declaration. Schemas are validated during
/// deserialization and again when the full declaration is checked against its
/// matching `provides` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContributionDeclaration {
    pub id: CapabilityId,
    pub kind: ContributionKind,
    #[serde(deserialize_with = "crate::manifest::deserialize_contract_major")]
    pub contract_major: u64,
    pub label: String,
    pub purpose: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<BoundedJsonSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<BoundedJsonSchema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media_types: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_slot: Option<String>,
}

impl ContributionDeclaration {
    pub(crate) fn validate_shape(&self) -> Result<(), String> {
        if self.contract_major == 0 {
            return Err("contribution contractMajor must be positive".to_string());
        }
        if ContributionKind::parse(self.id.as_str()) != Some(self.kind) {
            return Err(format!(
                "contribution {} does not match kind {:?}",
                self.id, self.kind
            ));
        }
        validate_untrusted_text(&self.label, MAX_CONTRIBUTION_LABEL_BYTES, "label")?;
        validate_untrusted_text(&self.purpose, MAX_CONTRIBUTION_PURPOSE_BYTES, "purpose")?;
        validate_media_types(&self.media_types)?;

        let has_call_schemas = self.input_schema.is_some() && self.output_schema.is_some();
        let has_partial_schemas = self.input_schema.is_some() != self.output_schema.is_some();
        if has_partial_schemas {
            return Err("inputSchema and outputSchema must be declared together".to_string());
        }

        match self.kind {
            ContributionKind::Tool
            | ContributionKind::Source
            | ContributionKind::Command
            | ContributionKind::Viewer => {
                if !has_call_schemas {
                    return Err(format!("contribution {} requires call schemas", self.id));
                }
                if self.skill_path.is_some() || self.panel_slot.is_some() {
                    return Err(format!(
                        "contribution {} declares fields owned by another kind",
                        self.id
                    ));
                }
                if self.kind != ContributionKind::Viewer && !self.media_types.is_empty() {
                    return Err(format!(
                        "contribution {} cannot declare mediaTypes",
                        self.id
                    ));
                }
            }
            ContributionKind::Panel => {
                if !has_call_schemas
                    || self.panel_slot.as_deref() != Some(PLUGIN_DETAILS_PANEL_SLOT)
                    || self.skill_path.is_some()
                    || !self.media_types.is_empty()
                {
                    return Err(format!(
                        "panel {} requires call schemas and panelSlot={PLUGIN_DETAILS_PANEL_SLOT}",
                        self.id
                    ));
                }
            }
            ContributionKind::Skill => {
                if self.skill_path.is_none()
                    || has_call_schemas
                    || self.panel_slot.is_some()
                    || !self.media_types.is_empty()
                {
                    return Err(format!(
                        "skill {} must declare only skillPath metadata",
                        self.id
                    ));
                }
            }
        }
        Ok(())
    }
}

/// A single declarative contribution. The label and purpose are untrusted
/// plugin text; they are rendered by the trusted shell with origin tagging and
/// never treated as system consequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contribution {
    pub capability: CapabilityId,
    pub kind: ContributionKind,
    pub contract_major: u64,
    pub label: String,
    pub purpose: String,
    pub input_schema: Option<BoundedJsonSchema>,
    pub output_schema: Option<BoundedJsonSchema>,
    pub media_types: Vec<String>,
    pub skill_path: Option<String>,
    pub panel_slot: Option<String>,
}

impl Contribution {
    pub fn new(
        capability: CapabilityId,
        kind: ContributionKind,
        label: impl Into<String>,
        purpose: impl Into<String>,
    ) -> Self {
        let call_schema = (kind != ContributionKind::Skill).then(|| {
            BoundedJsonSchema::new(json!({"type": "object", "properties": {}}))
                .expect("static empty-object contribution schema is valid")
        });
        Self {
            capability,
            kind,
            contract_major: 1,
            label: label.into(),
            purpose: purpose.into(),
            input_schema: call_schema.clone(),
            output_schema: call_schema,
            media_types: Vec::new(),
            skill_path: None,
            panel_slot: (kind == ContributionKind::Panel)
                .then(|| PLUGIN_DETAILS_PANEL_SLOT.to_string()),
        }
    }

    pub fn from_declaration(
        declaration: ContributionDeclaration,
    ) -> Result<Self, ContributionError> {
        declaration
            .validate_shape()
            .map_err(|_| ContributionError::Invalid)?;
        Ok(Self {
            capability: declaration.id,
            kind: declaration.kind,
            contract_major: declaration.contract_major,
            label: declaration.label,
            purpose: declaration.purpose,
            input_schema: declaration.input_schema,
            output_schema: declaration.output_schema,
            media_types: declaration.media_types,
            skill_path: declaration.skill_path,
            panel_slot: declaration.panel_slot,
        })
    }

    fn is_valid(&self) -> bool {
        ContributionDeclaration {
            id: self.capability.clone(),
            kind: self.kind,
            contract_major: self.contract_major,
            label: self.label.clone(),
            purpose: self.purpose.clone(),
            input_schema: self.input_schema.clone(),
            output_schema: self.output_schema.clone(),
            media_types: self.media_types.clone(),
            skill_path: self.skill_path.clone(),
            panel_slot: self.panel_slot.clone(),
        }
        .validate_shape()
        .is_ok()
    }
}

fn validate_untrusted_text(value: &str, maximum_bytes: usize, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.chars().any(char::is_control)
        || contains_bidi_override(value)
    {
        return Err(format!(
            "contribution {field} is empty, oversized, or contains unsafe controls"
        ));
    }
    let lowercase = value.to_lowercase();
    if value.contains(['<', '>', '`'])
        || value.contains("![")
        || value.contains("](")
        || ["http://", "https://", "file://", "data:", "www."]
            .iter()
            .any(|marker| lowercase.contains(marker))
    {
        return Err(format!(
            "contribution {field} must be plain text without markup or URLs"
        ));
    }
    if [
        "approval",
        "credential",
        "password",
        "updater",
        "security alert",
        "system dialog",
    ]
    .iter()
    .any(|term| lowercase.contains(term))
    {
        return Err(format!(
            "contribution {field} uses reserved trusted-surface terminology"
        ));
    }
    Ok(())
}

fn validate_media_types(media_types: &[String]) -> Result<(), String> {
    if media_types.len() > MAX_CONTRIBUTION_MEDIA_TYPES {
        return Err(format!(
            "mediaTypes exceed {MAX_CONTRIBUTION_MEDIA_TYPES} entries"
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for media_type in media_types {
        let parts = media_type.split_once('/');
        if media_type.is_empty()
            || media_type.len() > MAX_CONTRIBUTION_MEDIA_TYPE_BYTES
            || media_type.contains('*')
            || media_type.contains(';')
            || media_type.matches('/').count() != 1
            || parts.is_none_or(|(top, subtype)| top.is_empty() || subtype.is_empty())
            || !media_type.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'/' | b'+' | b'.' | b'-')
            })
            || !seen.insert(media_type.as_str())
        {
            return Err(format!("invalid or duplicate media type: {media_type}"));
        }
    }
    Ok(())
}

fn contains_bidi_override(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(
            character,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
    })
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

    #[test]
    fn source_and_named_panel_are_first_class_reversible_contracts() {
        let mut store = ContributionStore::new();
        let project = scope("scope.project");
        register(
            &mut store,
            &project,
            "org.example.a",
            "pkg",
            Contribution::new(
                capability("source.csv.metadata"),
                ContributionKind::Source,
                "CSV metadata",
                "Provide bounded project context",
            ),
        )
        .unwrap();
        register(
            &mut store,
            &project,
            "org.example.a",
            "pkg",
            Contribution::new(
                capability("ui.panel.csv"),
                ContributionKind::Panel,
                "CSV details",
                "Show bounded CSV details",
            ),
        )
        .unwrap();
        assert_eq!(store.list(&project).len(), 2);
        store.clear_instance(
            &project,
            &plugin("org.example.a"),
            &digest("pkg"),
            generation(),
            &host(),
        );
        assert!(store.list(&project).is_empty());
    }

    #[test]
    fn text_media_and_panel_spoofing_are_rejected() {
        let mut store = ContributionStore::new();
        let project = scope("scope.project");
        for label in [
            "<b>Trusted</b>",
            "https://example.org",
            "Approval request",
            "Unsafe\u{202e}label",
        ] {
            let contribution = Contribution::new(
                capability("tool.fixture.read"),
                ContributionKind::Tool,
                label,
                "Read bounded fixture data",
            );
            assert_eq!(
                register(&mut store, &project, "org.example.a", "pkg", contribution),
                Err(ContributionError::Invalid)
            );
        }

        let mut wrong_panel = Contribution::new(
            capability("ui.panel.csv"),
            ContributionKind::Panel,
            "CSV details",
            "Show bounded CSV details",
        );
        wrong_panel.panel_slot = Some("environment".to_string());
        assert_eq!(
            register(&mut store, &project, "org.example.a", "pkg", wrong_panel),
            Err(ContributionError::Invalid)
        );

        let mut unsafe_media = Contribution::new(
            capability("ui.viewer.csv"),
            ContributionKind::Viewer,
            "CSV viewer",
            "Show bounded CSV details",
        );
        unsafe_media.media_types = vec!["text/*".to_string()];
        assert_eq!(
            register(&mut store, &project, "org.example.a", "pkg", unsafe_media),
            Err(ContributionError::Invalid)
        );
    }

    #[test]
    fn project_budget_accepts_256_and_rejects_257() {
        let mut store = ContributionStore::new();
        let project = scope("scope.project");
        for index in 0..MAX_CONTRIBUTIONS_PER_PROJECT {
            register(
                &mut store,
                &project,
                "org.example.a",
                "pkg",
                Contribution::new(
                    capability(&format!("tool.fixture.item{index}")),
                    ContributionKind::Tool,
                    format!("Fixture item {index}"),
                    "Exercise the resolved project contribution budget",
                ),
            )
            .unwrap();
        }
        assert_eq!(store.list(&project).len(), MAX_CONTRIBUTIONS_PER_PROJECT);
        assert_eq!(
            register(
                &mut store,
                &project,
                "org.example.a",
                "pkg",
                Contribution::new(
                    capability("tool.fixture.overflow"),
                    ContributionKind::Tool,
                    "Overflow",
                    "Must not exceed the project contribution budget",
                ),
            ),
            Err(ContributionError::LimitExceeded)
        );
    }
}
