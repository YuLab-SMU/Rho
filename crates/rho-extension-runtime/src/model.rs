use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    str::FromStr,
};

use semver::Version;
use serde::{Deserialize, Serialize};

use crate::{
    ActivationGeneration, CapabilityId, DescriptorErrorReason, ExtensionDiagnostic, ExtensionError,
    InvalidParentContext, InvalidParentReason, InvalidScopePolicyReason, InvalidScopeReason,
    LimitKind, MAX_OPTIONAL_PER_PLUGIN, MAX_PROVIDES_PER_PLUGIN, MAX_REQUIRED_PER_PLUGIN, PluginId,
    ScopeId, ScopeKindId,
};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PluginVersion(Version);

impl PluginVersion {
    pub fn new(version: Version) -> Self {
        Self(version)
    }

    pub fn parse(value: &str) -> Result<Self, ExtensionError> {
        Version::parse(value)
            .map(Self)
            .map_err(|_| ExtensionError::InvalidPluginVersion)
    }

    pub fn as_semver(&self) -> &Version {
        &self.0
    }

    pub fn into_semver(self) -> Version {
        self.0
    }
}

impl fmt::Display for PluginVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for PluginVersion {
    type Err = ExtensionError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CapabilityContractMajor(pub u64);

impl CapabilityContractMajor {
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for CapabilityContractMajor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct CapabilityDeclaration {
    pub capability_id: CapabilityId,
    pub contract_major: CapabilityContractMajor,
}

impl CapabilityDeclaration {
    pub fn new(capability_id: CapabilityId, contract_major: u64) -> Self {
        Self {
            capability_id,
            contract_major: CapabilityContractMajor::new(contract_major),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct CapabilityRequirement {
    pub capability_id: CapabilityId,
    pub contract_major: CapabilityContractMajor,
}

impl CapabilityRequirement {
    pub fn new(capability_id: CapabilityId, contract_major: u64) -> Self {
        Self {
            capability_id,
            contract_major: CapabilityContractMajor::new(contract_major),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationPolicy {
    Eager,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PluginDescriptor {
    pub id: PluginId,
    pub version: PluginVersion,
    pub allowed_scopes: Vec<ScopeKindId>,
    pub provides: Vec<CapabilityDeclaration>,
    pub requires: Vec<CapabilityRequirement>,
    pub optional: Vec<CapabilityRequirement>,
    pub activation_policy: ActivationPolicy,
}

impl PluginDescriptor {
    pub fn new(id: PluginId, version: PluginVersion, allowed_scopes: Vec<ScopeKindId>) -> Self {
        Self {
            id,
            version,
            allowed_scopes,
            provides: Vec::new(),
            requires: Vec::new(),
            optional: Vec::new(),
            activation_policy: ActivationPolicy::Eager,
        }
    }

    pub(crate) fn normalize(&mut self) {
        self.allowed_scopes.sort();
        self.provides.sort();
        self.requires.sort();
        self.optional.sort();
    }

    pub(crate) fn validate_for_scope(
        &self,
        scope_kind: &ScopeKindId,
    ) -> Result<(), ExtensionError> {
        if self.provides.len() > MAX_PROVIDES_PER_PLUGIN {
            return Err(ExtensionError::LimitExceeded {
                limit: LimitKind::ProvidesPerPlugin,
                plugin_id: Some(self.id.clone()),
                actual: self.provides.len(),
                maximum: MAX_PROVIDES_PER_PLUGIN,
            });
        }
        if self.requires.len() > MAX_REQUIRED_PER_PLUGIN {
            return Err(ExtensionError::LimitExceeded {
                limit: LimitKind::RequiredPerPlugin,
                plugin_id: Some(self.id.clone()),
                actual: self.requires.len(),
                maximum: MAX_REQUIRED_PER_PLUGIN,
            });
        }
        if self.optional.len() > MAX_OPTIONAL_PER_PLUGIN {
            return Err(ExtensionError::LimitExceeded {
                limit: LimitKind::OptionalPerPlugin,
                plugin_id: Some(self.id.clone()),
                actual: self.optional.len(),
                maximum: MAX_OPTIONAL_PER_PLUGIN,
            });
        }
        if self.allowed_scopes.is_empty() {
            return Err(ExtensionError::InvalidDescriptor {
                plugin_id: self.id.clone(),
                reason: DescriptorErrorReason::NoAllowedScopes,
            });
        }
        if let Some(scope_kind) = duplicate_by_key(&self.allowed_scopes, |value| value) {
            return Err(ExtensionError::InvalidDescriptor {
                plugin_id: self.id.clone(),
                reason: DescriptorErrorReason::DuplicateAllowedScope {
                    scope_kind: scope_kind.clone(),
                },
            });
        }
        if let Some(declaration) = duplicate_by_key(&self.provides, |value| &value.capability_id) {
            return Err(ExtensionError::InvalidDescriptor {
                plugin_id: self.id.clone(),
                reason: DescriptorErrorReason::DuplicateProvidedCapability {
                    capability_id: declaration.capability_id.clone(),
                },
            });
        }
        if let Some(requirement) = duplicate_by_key(&self.requires, |value| &value.capability_id) {
            return Err(ExtensionError::InvalidDescriptor {
                plugin_id: self.id.clone(),
                reason: DescriptorErrorReason::DuplicateRequiredCapability {
                    capability_id: requirement.capability_id.clone(),
                },
            });
        }
        if let Some(requirement) = duplicate_by_key(&self.optional, |value| &value.capability_id) {
            return Err(ExtensionError::InvalidDescriptor {
                plugin_id: self.id.clone(),
                reason: DescriptorErrorReason::DuplicateOptionalCapability {
                    capability_id: requirement.capability_id.clone(),
                },
            });
        }

        let required: BTreeSet<_> = self
            .requires
            .iter()
            .map(|value| &value.capability_id)
            .collect();
        if let Some(requirement) = self
            .optional
            .iter()
            .find(|value| required.contains(&value.capability_id))
        {
            return Err(ExtensionError::InvalidDescriptor {
                plugin_id: self.id.clone(),
                reason: DescriptorErrorReason::RequiredAndOptionalCapability {
                    capability_id: requirement.capability_id.clone(),
                },
            });
        }
        if self.allowed_scopes.binary_search(scope_kind).is_err() {
            return Err(ExtensionError::InvalidDescriptor {
                plugin_id: self.id.clone(),
                reason: DescriptorErrorReason::ScopeNotAllowed {
                    scope_kind: scope_kind.clone(),
                },
            });
        }
        Ok(())
    }
}

fn duplicate_by_key<'a, T, K: Ord + ?Sized + 'a>(
    values: &'a [T],
    key: impl Fn(&'a T) -> &'a K,
) -> Option<&'a T> {
    values
        .windows(2)
        .find(|window| key(&window[0]) == key(&window[1]))
        .map(|window| &window[1])
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ScopeIdentity {
    pub kind: ScopeKindId,
    pub id: ScopeId,
    pub parent_id: Option<ScopeId>,
    pub generation: ActivationGeneration,
}

impl ScopeIdentity {
    pub fn new(
        kind: ScopeKindId,
        id: ScopeId,
        parent_id: Option<ScopeId>,
        generation: ActivationGeneration,
    ) -> Self {
        Self {
            kind,
            id,
            parent_id,
            generation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ScopeKindRule {
    pub kind: ScopeKindId,
    pub parent_kind: Option<ScopeKindId>,
}

impl ScopeKindRule {
    pub fn root(kind: ScopeKindId) -> Self {
        Self {
            kind,
            parent_kind: None,
        }
    }

    pub fn child(kind: ScopeKindId, parent_kind: ScopeKindId) -> Self {
        Self {
            kind,
            parent_kind: Some(parent_kind),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScopePolicy {
    rules: BTreeMap<ScopeKindId, Option<ScopeKindId>>,
}

impl ScopePolicy {
    pub fn from_host_rules(mut rules: Vec<ScopeKindRule>) -> Result<Self, ExtensionError> {
        rules.sort();
        if let Some(duplicate) = rules
            .windows(2)
            .find(|window| window[0].kind == window[1].kind)
        {
            return Err(ExtensionError::InvalidScopePolicy {
                scope_kind: duplicate[0].kind.clone(),
                reason: InvalidScopePolicyReason::DuplicateKind,
            });
        }

        let rules: BTreeMap<_, _> = rules
            .into_iter()
            .map(|rule| (rule.kind, rule.parent_kind))
            .collect();

        for (kind, parent_kind) in &rules {
            if let Some(parent_kind) = parent_kind
                && !rules.contains_key(parent_kind)
            {
                return Err(ExtensionError::InvalidScopePolicy {
                    scope_kind: kind.clone(),
                    reason: InvalidScopePolicyReason::MissingParentKind,
                });
            }
        }

        for start in rules.keys() {
            let mut seen = BTreeSet::new();
            let mut current = Some(start);
            while let Some(kind) = current {
                if !seen.insert(kind.clone()) {
                    return Err(ExtensionError::InvalidScopePolicy {
                        scope_kind: kind.clone(),
                        reason: InvalidScopePolicyReason::ParentCycle,
                    });
                }
                current = rules.get(kind).and_then(Option::as_ref);
            }
        }

        Ok(Self { rules })
    }

    pub fn phase_one() -> Self {
        let application = Self::application_kind();
        let project = Self::project_kind();
        Self::from_host_rules(vec![
            ScopeKindRule::root(application.clone()),
            ScopeKindRule::child(project.clone(), application),
            ScopeKindRule::child(Self::workspace_kind(), project.clone()),
            ScopeKindRule::child(Self::agent_kind(), project),
        ])
        .expect("the built-in Phase 1 scope policy must be valid")
    }

    pub fn application_kind() -> ScopeKindId {
        ScopeKindId::new("application").expect("built-in identifier must be valid")
    }

    pub fn project_kind() -> ScopeKindId {
        ScopeKindId::new("project").expect("built-in identifier must be valid")
    }

    pub fn workspace_kind() -> ScopeKindId {
        ScopeKindId::new("workspace").expect("built-in identifier must be valid")
    }

    pub fn agent_kind() -> ScopeKindId {
        ScopeKindId::new("agent").expect("built-in identifier must be valid")
    }

    pub fn rules(&self) -> &BTreeMap<ScopeKindId, Option<ScopeKindId>> {
        &self.rules
    }

    pub fn validate_identity(
        &self,
        scope: &ScopeIdentity,
        parent: Option<&ScopeIdentity>,
    ) -> Result<(), ExtensionError> {
        let expected_parent_kind =
            self.rules
                .get(&scope.kind)
                .ok_or_else(|| ExtensionError::InvalidScope {
                    scope_id: scope.id.clone(),
                    scope_kind: scope.kind.clone(),
                    reason: InvalidScopeReason::UnknownKind,
                })?;

        match expected_parent_kind {
            None => {
                if scope.parent_id.is_some() || parent.is_some() {
                    return Err(invalid_parent(
                        scope,
                        parent,
                        None,
                        InvalidParentReason::UnexpectedParent,
                    ));
                }
            }
            Some(expected_kind) => {
                let Some(parent_id) = scope.parent_id.as_ref() else {
                    return Err(invalid_parent(
                        scope,
                        parent,
                        Some(expected_kind),
                        InvalidParentReason::MissingParent,
                    ));
                };
                let Some(parent) = parent else {
                    return Err(invalid_parent(
                        scope,
                        None,
                        Some(expected_kind),
                        InvalidParentReason::ParentIdentityMissing,
                    ));
                };
                if parent_id != &parent.id {
                    return Err(invalid_parent(
                        scope,
                        Some(parent),
                        Some(expected_kind),
                        InvalidParentReason::ParentIdMismatch,
                    ));
                }
                if &parent.kind != expected_kind {
                    return Err(invalid_parent(
                        scope,
                        Some(parent),
                        Some(expected_kind),
                        InvalidParentReason::ParentKindMismatch,
                    ));
                }
            }
        }
        Ok(())
    }
}

fn invalid_parent(
    scope: &ScopeIdentity,
    parent: Option<&ScopeIdentity>,
    expected_parent_kind: Option<&ScopeKindId>,
    reason: InvalidParentReason,
) -> ExtensionError {
    ExtensionError::InvalidParent {
        context: Box::new(InvalidParentContext {
            scope_id: scope.id.clone(),
            scope_kind: scope.kind.clone(),
            parent_scope_id: scope
                .parent_id
                .clone()
                .or_else(|| parent.map(|value| value.id.clone())),
            parent_scope_kind: parent.map(|value| value.kind.clone()),
            expected_parent_kind: expected_parent_kind.cloned(),
        }),
        reason,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ProviderIdentity {
    pub plugin_id: PluginId,
    pub scope: ScopeIdentity,
    pub contract_major: CapabilityContractMajor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementKind {
    Required,
    Optional,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BindingResolution {
    Provider { provider: ProviderIdentity },
    AbsentOptional,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequirementBinding {
    pub requirement: CapabilityRequirement,
    pub kind: RequirementKind,
    pub resolution: BindingResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivationPlan {
    scope: ScopeIdentity,
    activation_order: Vec<PluginId>,
    bindings: BTreeMap<PluginId, Vec<RequirementBinding>>,
    effective_providers: BTreeMap<CapabilityId, ProviderIdentity>,
    diagnostics: Vec<ExtensionDiagnostic>,
}

impl ActivationPlan {
    pub(crate) fn new(
        scope: ScopeIdentity,
        activation_order: Vec<PluginId>,
        bindings: BTreeMap<PluginId, Vec<RequirementBinding>>,
        effective_providers: BTreeMap<CapabilityId, ProviderIdentity>,
        diagnostics: Vec<ExtensionDiagnostic>,
    ) -> Self {
        Self {
            scope,
            activation_order,
            bindings,
            effective_providers,
            diagnostics,
        }
    }

    pub fn scope(&self) -> &ScopeIdentity {
        &self.scope
    }

    pub fn activation_order(&self) -> &[PluginId] {
        &self.activation_order
    }

    pub fn bindings(&self) -> &BTreeMap<PluginId, Vec<RequirementBinding>> {
        &self.bindings
    }

    pub fn effective_providers(&self) -> &BTreeMap<CapabilityId, ProviderIdentity> {
        &self.effective_providers
    }

    pub fn diagnostics(&self) -> &[ExtensionDiagnostic] {
        &self.diagnostics
    }
}
