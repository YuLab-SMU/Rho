use super::frontmatter;
use async_trait::async_trait;
use rho_contract::SkillEnablement;
use rho_operation::OperationError;
use rho_skills::{
    MAX_PACKAGES, MAX_RESOURCES, MAX_SKILL_BYTES, MAX_SOURCE_BYTES, SkillScope, SkillSource,
    SkillSourceInventory, SourcePackage, SourceResource, hash, package_digest, validate_relative,
};
use std::{collections::BTreeMap, sync::RwLock};

/// Supplied by the actual host discovery integration, preserving its existing resource references.
#[derive(Debug, Clone)]
pub struct HostProvidedPackage {
    pub source_key: String,
    pub canonical_resource: String,
    pub location: String,
    pub enablement: SkillEnablement,
    pub reason: Option<String>,
    pub resources: BTreeMap<String, Vec<u8>>,
}
#[derive(Debug, Clone, Default)]
pub struct HostProvidedSnapshot {
    pub revision: u64,
    pub packages: Vec<HostProvidedPackage>,
}
/// A trusted composition port. Source identity/principal are fixed at construction, not accepted from query arguments.
pub struct HostProvidedSkillSource {
    source_id: String,
    project_root: String,
    principal: String,
    state: RwLock<HostProvidedSnapshot>,
}
impl HostProvidedSkillSource {
    pub fn new(
        source_id: String,
        project_root: String,
        principal: String,
    ) -> Result<Self, OperationError> {
        if source_id.is_empty()
            || source_id.len() > 160
            || source_id == "local-standard"
            || principal.is_empty()
        {
            return Err(OperationError::InvalidInput(
                "Trusted host Skill source needs a distinct fixed provider and principal".into(),
            ));
        }
        Ok(Self {
            source_id,
            project_root,
            principal,
            state: RwLock::new(HostProvidedSnapshot::default()),
        })
    }
    /// Host calls only after authenticating its source adapter. Agent-selected method bindings never call this port.
    pub fn replace(
        &self,
        expected_revision: u64,
        packages: Vec<HostProvidedPackage>,
    ) -> Result<u64, OperationError> {
        if packages.len() > MAX_PACKAGES {
            return Err(OperationError::BudgetExceeded(
                "Host source exceeds 2000 Skills".into(),
            ));
        }
        let mut total = 0usize;
        let mut keys = std::collections::BTreeSet::new();
        for package in &packages {
            if package.source_key.is_empty()
                || package.source_key.len() > 4096
                || package.canonical_resource.len() > 4096
                || !keys.insert(&package.source_key)
            {
                return Err(OperationError::InvalidInput(
                    "Host Skill keys must be distinct and bounded".into(),
                ));
            }
            if package.resources.len() > MAX_RESOURCES
                || !package.resources.contains_key("SKILL.md")
            {
                return Err(OperationError::InvalidInput(
                    "Host Skill needs SKILL.md and at most 2000 resources".into(),
                ));
            }
            for (path, bytes) in &package.resources {
                validate_relative(path, false)?;
                if bytes.len() > MAX_SKILL_BYTES {
                    return Err(OperationError::BudgetExceeded(
                        "Host Skill resource exceeds 16 MiB".into(),
                    ));
                }
                total = total.checked_add(bytes.len()).ok_or_else(|| {
                    OperationError::BudgetExceeded("Host Skill content budget overflow".into())
                })?;
            }
        }
        if total > MAX_SOURCE_BYTES {
            return Err(OperationError::BudgetExceeded(
                "Host Skill source exceeds 64 MiB".into(),
            ));
        }
        let mut state = self
            .state
            .write()
            .map_err(|_| OperationError::Unavailable("Host Skill source lock poisoned".into()))?;
        if state.revision != expected_revision {
            return Err(OperationError::ContentChanged(
                "Host Skill source revision changed; inspect provider state before publishing"
                    .into(),
            ));
        }
        state.revision = state.revision.checked_add(1).ok_or_else(|| {
            OperationError::BudgetExceeded("Host Skill source revision exhausted".into())
        })?;
        state.packages = packages;
        Ok(state.revision)
    }
    pub fn revision(&self) -> Result<u64, OperationError> {
        Ok(self
            .state
            .read()
            .map_err(|_| OperationError::Unavailable("Host Skill source lock poisoned".into()))?
            .revision)
    }
    fn visible(&self, scope: &SkillScope) -> bool {
        scope.principal == self.principal && scope.project_root == self.project_root
    }
    fn package(&self, package: &HostProvidedPackage) -> Result<SourcePackage, OperationError> {
        let resources = package
            .resources
            .iter()
            .map(|(path, bytes)| SourceResource {
                path: path.clone(),
                sha256: hash(bytes),
                byte_size: bytes.len() as u64,
                identity: format!("{}#{}", package.canonical_resource, path),
            })
            .collect();
        Ok(SourcePackage {
            metadata_policy: rho_skills::SkillMetadataPolicy::HostAttested,
            source_id: self.source_id.clone(),
            key: package.source_key.clone(),
            canonical_resource: package.canonical_resource.clone(),
            location: package.location.clone(),
            enablement: package.enablement.clone(),
            reason: package.reason.clone(),
            frontmatter: frontmatter(&package.resources["SKILL.md"])?,
            resources,
        })
    }
}
#[async_trait]
impl SkillSource for HostProvidedSkillSource {
    fn source_id(&self) -> &str {
        &self.source_id
    }
    async fn discover(&self, scope: &SkillScope) -> Result<SkillSourceInventory, OperationError> {
        if !self.visible(scope) {
            return Ok(SkillSourceInventory::default());
        }
        let state = self
            .state
            .read()
            .map_err(|_| OperationError::Unavailable("Host Skill source lock poisoned".into()))?;
        let mut result = SkillSourceInventory::default();
        for package in &state.packages {
            match self.package(package) {
                Ok(p) => result.packages.push(p),
                Err(e) => result.notices.push(rho_contract::SkillSourceNotice {
                    source_id: self.source_id.clone(),
                    location: package.location.clone(),
                    code: "invalid_skill".into(),
                    message: e.to_string(),
                }),
            }
        }
        Ok(result)
    }
    async fn read(
        &self,
        scope: &SkillScope,
        package: &SourcePackage,
        path: &str,
    ) -> Result<Vec<u8>, OperationError> {
        if !self.visible(scope) {
            return Err(OperationError::Unavailable(
                "Host Skill source is not visible to this principal/project".into(),
            ));
        }
        let state = self
            .state
            .read()
            .map_err(|_| OperationError::Unavailable("Host Skill source lock poisoned".into()))?;
        let current = state
            .packages
            .iter()
            .find(|p| p.source_key == package.key)
            .ok_or_else(|| OperationError::ContentChanged("Host Skill was removed".into()))?;
        if current.enablement != SkillEnablement::Enabled {
            return Err(OperationError::Unavailable(
                "Host disabled or rejected the Skill".into(),
            ));
        }
        if package_digest(&self.package(current)?) != package_digest(package) {
            return Err(OperationError::ContentChanged(
                "Host Skill package changed".into(),
            ));
        }
        current
            .resources
            .get(path)
            .cloned()
            .ok_or_else(|| OperationError::InvalidInput("Unknown host Skill resource".into()))
    }
}
