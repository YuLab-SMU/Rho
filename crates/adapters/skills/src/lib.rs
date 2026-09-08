#![forbid(unsafe_code)]
mod host_manifest;
mod provided;
use async_trait::async_trait;
pub use host_manifest::HostDiscoveredSkillSource;
pub use provided::{HostProvidedPackage, HostProvidedSkillSource, HostProvidedSnapshot};
use rho_contract::{SkillEnablement, SkillSourceNotice};
use rho_operation::OperationError;
use rho_skills::{
    MAX_FRONTMATTER_BYTES, MAX_PACKAGES, MAX_RESOURCES, MAX_SKILL_BYTES, MAX_SOURCE_BYTES,
    SkillScope, SkillSource, SkillSourceInventory, SourcePackage, SourceResource, hash,
    package_digest, validate_relative,
};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
};

/// Only the two standard local sources. The Host provides the canonical project/user roots.
#[derive(Clone)]
pub struct FilesystemSkillSource {
    project: PathBuf,
    user_skills: Option<PathBuf>,
    excluded_paths: Vec<PathBuf>,
}
impl FilesystemSkillSource {
    pub fn new(project_root: &Path, user_home: Option<&Path>) -> Result<Self, OperationError> {
        let project = project_root.canonicalize().map_err(io_error)?;
        Ok(Self {
            project,
            user_skills: user_home.map(|p| p.join(".agents/skills")),
            excluded_paths: vec![],
        })
    }
    /// Use the same Host-owned data exclusions as the Project file adapter.
    pub fn with_excluded_paths(mut self, paths: Vec<PathBuf>) -> Result<Self, OperationError> {
        let mut excluded = Vec::new();
        for path in paths {
            let absolute = if path.is_absolute() {
                path
            } else {
                std::env::current_dir().map_err(io_error)?.join(path)
            };
            excluded.push(normalize_exclusion(&absolute)?);
            excluded.push(absolute);
        }
        excluded.sort();
        excluded.dedup();
        self.excluded_paths = excluded;
        Ok(self)
    }
    fn roots(&self, scope: &SkillScope) -> Result<Vec<(String, PathBuf, bool)>, OperationError> {
        if scope.project_root != self.project.to_string_lossy() {
            return Err(OperationError::InvalidInput(
                "Skill source project identity mismatch".into(),
            ));
        }
        validate_relative(&scope.working_directory, true)?;
        let directory = self
            .project
            .join(&scope.working_directory)
            .canonicalize()
            .map_err(io_error)?;
        if !directory.starts_with(&self.project) || !directory.is_dir() {
            return Err(OperationError::InvalidInput(
                "Working directory escapes the project or is not a directory".into(),
            ));
        }
        let mut roots = vec![];
        for ancestor in directory.ancestors() {
            if !ancestor.starts_with(&self.project) {
                break;
            }
            roots.push((
                format!(
                    "project:{}",
                    ancestor
                        .strip_prefix(&self.project)
                        .unwrap()
                        .to_string_lossy()
                ),
                ancestor.join(".agents/skills"),
                true,
            ));
            if ancestor == self.project {
                break;
            }
        }
        if let Some(user) = &self.user_skills {
            roots.push(("user".into(), user.clone(), false));
        }
        Ok(roots)
    }
    fn package(
        &self,
        root: &Path,
        entry: &Path,
        project: bool,
        key: String,
        metadata_policy: rho_skills::SkillMetadataPolicy,
    ) -> Result<SourcePackage, OperationError> {
        let canonical_root = root.canonicalize().map_err(io_error)?;
        if project && !canonical_root.starts_with(&self.project) {
            return Err(OperationError::InvalidInput(
                "Project .agents/skills root escapes project containment".into(),
            ));
        }
        let canonical = entry.canonicalize().map_err(io_error)?;
        if project && !canonical.starts_with(&self.project) {
            return Err(OperationError::InvalidInput(
                "Project Skill symlink escapes project containment".into(),
            ));
        }
        if !canonical.is_dir() {
            return Err(OperationError::InvalidInput(
                "Skill entry is not a directory".into(),
            ));
        }
        let mut scan = ResourceScan::default();
        scan_resources(entry, entry, &canonical, &self.excluded_paths, &mut scan)?;
        let mut resources = scan.resources;
        if !resources.iter().any(|r| r.path == "SKILL.md") {
            return Err(OperationError::InvalidInput(
                "Skill package has no SKILL.md".into(),
            ));
        }
        let (body, _, _) = read_checked(
            &entry.join("SKILL.md"),
            &canonical,
            MAX_SKILL_BYTES,
            &self.excluded_paths,
        )?;
        if resources
            .iter()
            .find(|r| r.path == "SKILL.md")
            .is_none_or(|r| r.sha256 != hash(&body))
        {
            return Err(OperationError::ContentChanged(
                "SKILL.md changed between manifest and metadata reads".into(),
            ));
        }
        let frontmatter = frontmatter(&body)?;
        let metadata = rho_skills::parse_frontmatter_for(&frontmatter, metadata_policy)?;
        if metadata_policy == rho_skills::SkillMetadataPolicy::Standard
            && entry.file_name().and_then(|s| s.to_str()) != Some(metadata.name.as_str())
        {
            return Err(OperationError::InvalidInput(
                "Standard Skill name must match its package directory".into(),
            ));
        }
        resources.sort_by(|a, b| a.path.cmp(&b.path));
        if entry.canonicalize().map_err(io_error)? != canonical
            || root.canonicalize().map_err(io_error)? != canonical_root
        {
            return Err(OperationError::ContentChanged(
                "Skill root changed during discovery".into(),
            ));
        }
        Ok(SourcePackage {
            metadata_policy,
            source_id: self.source_id().into(),
            key,
            canonical_resource: canonical.to_string_lossy().into(),
            location: entry.join("SKILL.md").to_string_lossy().into(),
            enablement: SkillEnablement::Enabled,
            reason: None,
            frontmatter,
            resources,
        })
    }
}
impl FilesystemSkillSource {
    fn discover_sync(&self, scope: &SkillScope) -> Result<SkillSourceInventory, OperationError> {
        let mut result = SkillSourceInventory::default();
        let mut scanned = 0usize;
        let mut source_bytes = 0u64;
        for (label, root, project) in self.roots(scope)? {
            if fs::symlink_metadata(&root).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                continue;
            }
            let canonical = match root.canonicalize() {
                Ok(v) => v,
                Err(e) => {
                    result
                        .notices
                        .push(notice(&root, "source_unavailable", &e.to_string()));
                    continue;
                }
            };
            if project && !canonical.starts_with(&self.project) {
                result.notices.push(notice(
                    &root,
                    "containment",
                    "Project .agents/skills root resolves outside the project",
                ));
                continue;
            }
            let entries = match fs::read_dir(&root) {
                Ok(v) => v,
                Err(e) => {
                    result
                        .notices
                        .push(notice(&root, "source_unavailable", &e.to_string()));
                    continue;
                }
            };
            let mut entries = entries
                .take(MAX_PACKAGES + 1)
                .collect::<Result<Vec<_>, _>>()
                .map_err(io_error)?;
            if entries.len() > MAX_PACKAGES {
                return Err(OperationError::BudgetExceeded(
                    "Skill root exceeds 2000 entries".into(),
                ));
            }
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                scanned += 1;
                if scanned > MAX_PACKAGES {
                    return Err(OperationError::BudgetExceeded("Standard Skill discovery exceeds 2000 directory entries; reduce source contents".into()));
                }
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if fs::symlink_metadata(path.join("SKILL.md"))
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    result.notices.push(notice(
                        &path,
                        "invalid_name",
                        "Skill directory name is not valid UTF-8",
                    ));
                    continue;
                };
                match self.package(
                    &root,
                    &path,
                    project,
                    format!("{label}/{name}"),
                    rho_skills::SkillMetadataPolicy::Standard,
                ) {
                    Ok(package) => {
                        source_bytes += package.resources.iter().map(|r| r.byte_size).sum::<u64>();
                        if source_bytes > MAX_SOURCE_BYTES as u64 {
                            return Err(OperationError::BudgetExceeded(
                                "Skill discovery exceeds the 64 MiB source read budget".into(),
                            ));
                        }
                        result.packages.push(package);
                    }
                    Err(error) => {
                        result
                            .notices
                            .push(notice(&path, "invalid_package", &error.to_string()))
                    }
                }
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
        // Rediscover through configured roots, never accept the locator as arbitrary filesystem authority.
        let current = self
            .discover_sync(scope)?
            .packages
            .into_iter()
            .find(|p| p.key == package.key)
            .ok_or_else(|| OperationError::ContentChanged("Skill source disappeared".into()))?;
        if package_digest(&current) != package_digest(package) {
            return Err(OperationError::ContentChanged(
                "Skill body, script or source identity changed".into(),
            ));
        }
        let entry = Path::new(&current.location)
            .parent()
            .ok_or_else(|| OperationError::InvalidInput("Invalid Skill location".into()))?;
        let (bytes, _, _) = read_checked(
            &entry.join(path),
            Path::new(&current.canonical_resource),
            MAX_SKILL_BYTES,
            &self.excluded_paths,
        )?;
        let after = self
            .discover_sync(scope)?
            .packages
            .into_iter()
            .find(|p| p.key == package.key)
            .ok_or_else(|| {
                OperationError::ContentChanged("Skill source disappeared during read".into())
            })?;
        if package_digest(&after) != package_digest(package) {
            return Err(OperationError::ContentChanged(
                "Skill package changed during resource read".into(),
            ));
        }
        Ok(bytes)
    }
}
#[async_trait]
impl SkillSource for FilesystemSkillSource {
    fn source_id(&self) -> &str {
        "local-standard"
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

#[derive(Default)]
struct ResourceScan {
    seen: BTreeSet<PathBuf>,
    resources: Vec<SourceResource>,
    total_bytes: usize,
    visited: usize,
}
fn scan_resources(
    entry: &Path,
    path: &Path,
    anchor: &Path,
    excluded: &[PathBuf],
    scan: &mut ResourceScan,
) -> Result<(), OperationError> {
    scan.visited += 1;
    if scan.visited > MAX_RESOURCES {
        return Err(OperationError::BudgetExceeded(
            "Skill package traversal exceeds 2000 paths".into(),
        ));
    }
    let canonical = path.canonicalize().map_err(io_error)?;
    check_private(&canonical, excluded)?;
    if !canonical.starts_with(anchor) {
        return Err(OperationError::InvalidInput(
            "Skill resource symlink escapes its package root".into(),
        ));
    }
    if canonical.is_dir() {
        if !scan.seen.insert(canonical.clone()) {
            return Err(OperationError::InvalidInput(
                "Skill resource graph contains a directory cycle".into(),
            ));
        }
        if scan.seen.len() > 64 || scan.resources.len() > MAX_RESOURCES {
            return Err(OperationError::BudgetExceeded(
                "Skill package traversal exceeds 2000 paths".into(),
            ));
        }
        let mut entries = fs::read_dir(path)
            .map_err(io_error)?
            .take(MAX_RESOURCES + 1)
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        if entries.len() > MAX_RESOURCES {
            return Err(OperationError::BudgetExceeded(
                "Skill package directory exceeds 2000 entries".into(),
            ));
        }
        entries.sort_by_key(|e| e.file_name());
        for child in entries {
            scan_resources(entry, &child.path(), anchor, excluded, scan)?;
        }
        scan.seen.remove(&canonical);
    } else {
        if scan.resources.len() >= MAX_RESOURCES {
            return Err(OperationError::BudgetExceeded(
                "Skill package exceeds 2000 resources".into(),
            ));
        }
        let relative = path
            .strip_prefix(entry)
            .map_err(io_error)?
            .to_str()
            .ok_or_else(|| {
                OperationError::InvalidInput("Skill resource path is not valid UTF-8".into())
            })?
            .replace('\\', "/");
        validate_relative(&relative, false)?;
        let (bytes, identity, _) = read_checked(path, anchor, MAX_SKILL_BYTES, excluded)?;
        scan.total_bytes += bytes.len();
        if scan.total_bytes > MAX_SOURCE_BYTES {
            return Err(OperationError::BudgetExceeded(
                "Skill package content exceeds 64 MiB".into(),
            ));
        }
        scan.resources.push(SourceResource {
            path: relative,
            sha256: hash(&bytes),
            byte_size: bytes.len() as u64,
            identity,
        });
    }
    Ok(())
}
/// Resolve existing ancestors while preserving protected filenames that do not exist yet.
fn normalize_exclusion(path: &Path) -> Result<PathBuf, OperationError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(OperationError::InvalidInput(
                        "Invalid private path ancestor".into(),
                    ));
                }
            }
            std::path::Component::Normal(name) => {
                normalized.push(name);
                match normalized.canonicalize() {
                    Ok(canonical) => normalized = canonical,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(io_error(e)),
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn check_private(path: &Path, excluded: &[PathBuf]) -> Result<(), OperationError> {
    if path.components().any(|part| {
        part.as_os_str()
            .to_str()
            .is_some_and(|s| s.eq_ignore_ascii_case(".git") || s.eq_ignore_ascii_case(".rho"))
    }) {
        return Err(OperationError::InvalidInput(
            "Skill resource resolves into private Host or repository data".into(),
        ));
    }
    for root in excluded {
        if path.starts_with(root) || path.starts_with(normalize_exclusion(root)?) {
            return Err(OperationError::InvalidInput(
                "Skill resource resolves into private Host or repository data".into(),
            ));
        }
    }
    Ok(())
}

fn fingerprint(metadata: &Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{}:{:?}:{:?}",
            metadata.len(),
            metadata.modified(),
            metadata.created()
        )
    }
}
fn read_checked(
    path: &Path,
    anchor: &Path,
    maximum: usize,
    excluded: &[PathBuf],
) -> Result<(Vec<u8>, String, PathBuf), OperationError> {
    let canonical = path.canonicalize().map_err(io_error)?;
    check_private(&canonical, excluded)?;
    if !canonical.starts_with(anchor) {
        return Err(OperationError::InvalidInput(
            "Skill resource escaped its approved package root".into(),
        ));
    }
    let before = fs::metadata(&canonical).map_err(io_error)?;
    if !before.is_file() {
        return Err(OperationError::InvalidInput(
            "Skill resources must be regular files".into(),
        ));
    }
    if before.len() > maximum as u64 {
        return Err(OperationError::BudgetExceeded(format!(
            "Skill resource exceeds {maximum} bytes"
        )));
    }
    let mut file = File::open(&canonical).map_err(io_error)?;
    if fingerprint(&before) != fingerprint(&file.metadata().map_err(io_error)?) {
        return Err(OperationError::ContentChanged(
            "Skill file identity changed before reading".into(),
        ));
    }
    let mut bytes = vec![];
    (&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > maximum {
        return Err(OperationError::BudgetExceeded(format!(
            "Skill resource exceeds {maximum} bytes"
        )));
    }
    if path.canonicalize().map_err(io_error)? != canonical
        || fingerprint(&before) != fingerprint(&file.metadata().map_err(io_error)?)
        || fingerprint(&before) != fingerprint(&fs::metadata(&canonical).map_err(io_error)?)
    {
        return Err(OperationError::ContentChanged(
            "Skill content or symbolic link changed during reading".into(),
        ));
    }
    Ok((
        bytes,
        format!("{}:{}", canonical.to_string_lossy(), fingerprint(&before)),
        canonical,
    ))
}
pub fn frontmatter(bytes: &[u8]) -> Result<String, OperationError> {
    let mut lines = bytes.split_inclusive(|b| *b == b'\n');
    let clean = |line: &[u8]| {
        line.strip_suffix(b"\n")
            .unwrap_or(line)
            .strip_suffix(b"\r")
            .unwrap_or(line.strip_suffix(b"\n").unwrap_or(line))
            .to_vec()
    };
    if lines.next().is_none_or(|line| clean(line) != b"---") {
        return Err(OperationError::InvalidInput(
            "SKILL.md must begin with standard YAML frontmatter".into(),
        ));
    }
    let mut frontmatter = Vec::new();
    for line in lines {
        if clean(line) == b"---" {
            return String::from_utf8(frontmatter).map_err(|_| {
                OperationError::InvalidInput("Skill frontmatter is not UTF-8".into())
            });
        }
        if frontmatter.len() + line.len() > MAX_FRONTMATTER_BYTES {
            break;
        }
        frontmatter.extend_from_slice(line);
    }
    Err(OperationError::InvalidInput(
        "Skill frontmatter closing delimiter is absent within 64 KiB".into(),
    ))
}

fn notice(path: &Path, code: &str, message: &str) -> SkillSourceNotice {
    SkillSourceNotice {
        source_id: "local-standard".into(),
        location: path.to_string_lossy().into(),
        code: code.into(),
        message: message.chars().take(2048).collect(),
    }
}
fn io_error(error: impl std::fmt::Display) -> OperationError {
    OperationError::Unavailable(error.to_string())
}

#[cfg(test)]
mod exclusion_tests {
    use super::*;
    #[test]
    fn future_sqlite_sidecars_remain_excluded_after_creation() {
        let root = tempfile::tempdir().unwrap();
        let protected = root.path().join("future/app.studio.sqlite-wal");
        let source = FilesystemSkillSource::new(root.path(), None)
            .unwrap()
            .with_excluded_paths(vec![protected.clone()])
            .unwrap();
        fs::create_dir(root.path().join("future")).unwrap();
        fs::write(&protected, "private WAL").unwrap();
        assert!(check_private(&protected.canonicalize().unwrap(), &source.excluded_paths).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn exclusion_retains_configured_alias_when_its_existing_parent_link_changes() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        let alias = root.path().join("alias");
        symlink(&a, &alias).unwrap();
        let source = FilesystemSkillSource::new(root.path(), None)
            .unwrap()
            .with_excluded_paths(vec![alias.join("app.sqlite-shm")])
            .unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&b, &alias).unwrap();
        fs::write(b.join("app.sqlite-shm"), "private SHM").unwrap();
        assert!(
            check_private(
                &b.join("app.sqlite-shm").canonicalize().unwrap(),
                &source.excluded_paths
            )
            .is_err()
        );
    }
}
