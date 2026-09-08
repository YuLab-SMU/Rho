use super::*;
use rho_contract::{HostDiscoveredSkills, HostSkillSourceKind};
/// Exact roots attested by a native external-platform launcher. Never scans product catalogs.
#[derive(Clone)]
pub struct HostDiscoveredSkillSource {
    provider_id: String,
    principal: String,
    manifest_path: PathBuf,
    filesystem: FilesystemSkillSource,
}
impl HostDiscoveredSkillSource {
    pub fn from_manifest(
        project: &Path,
        principal: String,
        manifest_path: &Path,
        excluded_paths: Vec<PathBuf>,
    ) -> Result<Self, OperationError> {
        let manifest_path = manifest_path.canonicalize().map_err(io_error)?;
        let filesystem =
            FilesystemSkillSource::new(project, None)?.with_excluded_paths(excluded_paths)?;
        let manifest = read_manifest(&manifest_path)?;
        validate_manifest(&manifest)?;
        if principal.is_empty() {
            return Err(OperationError::InvalidInput(
                "Host Skill source needs its authenticated principal".into(),
            ));
        }
        Ok(Self {
            provider_id: manifest.provider_id,
            principal,
            manifest_path,
            filesystem,
        })
    }
    fn discover_sync(&self, scope: &SkillScope) -> Result<SkillSourceInventory, OperationError> {
        if scope.principal != self.principal
            || scope.project_root != self.filesystem.project.to_string_lossy()
        {
            return Ok(SkillSourceInventory::default());
        }
        self.filesystem.roots(scope)?;
        let manifest = read_manifest(&self.manifest_path)?;
        validate_manifest(&manifest)?;
        if manifest.provider_id != self.provider_id {
            return Err(OperationError::ContentChanged("Launcher Skill manifest changed provider identity; reconfigure the source explicitly".into()));
        }
        let mut result = SkillSourceInventory::default();
        let mut source_bytes = 0u64;
        for entry in manifest.skills {
            let root = PathBuf::from(&entry.root_path);
            let parent = root.parent().ok_or_else(|| {
                OperationError::InvalidInput("Host Skill root has no parent".into())
            })?;
            match self.filesystem.package(
                parent,
                &root,
                matches!(entry.source_kind, HostSkillSourceKind::Project),
                entry.source_key,
            ) {
                Ok(mut package) => {
                    package.source_id = self.provider_id.clone();
                    package.enablement = entry.enablement;
                    package.reason = entry.reason;
                    source_bytes += package.resources.iter().map(|r| r.byte_size).sum::<u64>();
                    if source_bytes > MAX_SOURCE_BYTES as u64 {
                        return Err(OperationError::BudgetExceeded(
                            "Host-discovered Skill resources exceed 64 MiB".into(),
                        ));
                    }
                    result.packages.push(package);
                }
                Err(error) => result.notices.push(SkillSourceNotice {
                    source_id: self.provider_id.clone(),
                    location: entry.root_path,
                    code: "host_resource_unavailable".into(),
                    message: error.to_string(),
                }),
            }
        }
        Ok(result)
    }
    fn read_sync(
        &self,
        scope: &SkillScope,
        package: &SourcePackage,
        path: &str,
    ) -> Result<Vec<u8>, OperationError> {
        validate_relative(path, false)?;
        let current = self
            .discover_sync(scope)?
            .packages
            .into_iter()
            .find(|p| p.key == package.key)
            .ok_or_else(|| {
                OperationError::ContentChanged(
                    "Host Skill resource is no longer declared or readable".into(),
                )
            })?;
        if current.enablement != SkillEnablement::Enabled {
            return Err(OperationError::Unavailable(
                "Actual host disabled or rejected this Skill".into(),
            ));
        }
        if package_digest(&current) != package_digest(package) {
            return Err(OperationError::ContentChanged(
                "Host Skill body, script, manifest or source state changed".into(),
            ));
        }
        let root = Path::new(&current.location)
            .parent()
            .ok_or_else(|| OperationError::InvalidInput("Invalid host Skill location".into()))?;
        let (bytes, _, _) = read_checked(
            &root.join(path),
            Path::new(&current.canonical_resource),
            MAX_SKILL_BYTES,
            &self.filesystem.excluded_paths,
        )?;
        let after = self
            .discover_sync(scope)?
            .packages
            .into_iter()
            .find(|p| p.key == package.key)
            .ok_or_else(|| {
                OperationError::ContentChanged("Host Skill source changed during reading".into())
            })?;
        if package_digest(&after) != package_digest(package) {
            return Err(OperationError::ContentChanged(
                "Host Skill resource changed during reading".into(),
            ));
        }
        Ok(bytes)
    }
}
#[async_trait]
impl SkillSource for HostDiscoveredSkillSource {
    fn source_id(&self) -> &str {
        &self.provider_id
    }
    async fn discover(&self, scope: &SkillScope) -> Result<SkillSourceInventory, OperationError> {
        let adapter = self.clone();
        let scope = scope.clone();
        tokio::task::spawn_blocking(move || adapter.discover_sync(&scope))
            .await
            .map_err(io_error)?
    }
    async fn read(
        &self,
        scope: &SkillScope,
        package: &SourcePackage,
        path: &str,
    ) -> Result<Vec<u8>, OperationError> {
        let adapter = self.clone();
        let scope = scope.clone();
        let package = package.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || adapter.read_sync(&scope, &package, &path))
            .await
            .map_err(io_error)?
    }
}
fn read_manifest(path: &Path) -> Result<HostDiscoveredSkills, OperationError> {
    let parent = path
        .parent()
        .ok_or_else(|| OperationError::InvalidInput("Invalid host manifest path".into()))?;
    // The manifest is trusted launch metadata; resource private-path policy applies to its declared roots.
    let (bytes, _, _) = read_checked(path, parent, 1024 * 1024, &[])?;
    serde_json::from_slice(&bytes).map_err(|e| {
        OperationError::InvalidInput(format!("Invalid host-discovered Skill manifest: {e}"))
    })
}
fn validate_manifest(manifest: &HostDiscoveredSkills) -> Result<(), OperationError> {
    if manifest.provider_id.is_empty()
        || manifest.provider_id.len() > 160
        || manifest.provider_id == "local-standard"
        || manifest.skills.len() > MAX_PACKAGES
    {
        return Err(OperationError::InvalidInput("Launcher Skill manifest needs a distinct bounded provider and at most 2000 declared roots".into()));
    }
    let mut keys = BTreeSet::new();
    for skill in &manifest.skills {
        if skill.source_key.is_empty()
            || skill.source_key.len() > 4096
            || !keys.insert(&skill.source_key)
            || skill.root_path.len() > 16384
            || !Path::new(&skill.root_path).is_absolute()
            || skill.reason.as_ref().is_some_and(|r| r.len() > 4096)
        {
            return Err(OperationError::InvalidInput("Host Skill roots must be explicit absolute paths with distinct bounded source keys".into()));
        }
    }
    Ok(())
}
