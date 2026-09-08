#![forbid(unsafe_code)]
mod provided;
use async_trait::async_trait;
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
pub struct FilesystemSkillSource {
    project: PathBuf,
    user_skills: Option<PathBuf>,
}
impl FilesystemSkillSource {
    pub fn new(project_root: &Path, user_home: Option<&Path>) -> Result<Self, OperationError> {
        let project = project_root.canonicalize().map_err(io_error)?;
        Ok(Self {
            project,
            user_skills: user_home.map(|p| p.join(".agents/skills")),
        })
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
        let mut resources = vec![];
        let mut seen = BTreeSet::new();
        let mut bytes = 0usize;
        scan_resources(
            entry,
            entry,
            &canonical,
            &mut seen,
            &mut resources,
            &mut bytes,
        )?;
        if !resources.iter().any(|r| r.path == "SKILL.md") {
            return Err(OperationError::InvalidInput(
                "Skill package has no SKILL.md".into(),
            ));
        }
        let (body, _, _) = read_checked(&entry.join("SKILL.md"), &canonical, MAX_SKILL_BYTES)?;
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
        resources.sort_by(|a, b| a.path.cmp(&b.path));
        if entry.canonicalize().map_err(io_error)? != canonical
            || root.canonicalize().map_err(io_error)? != canonical_root
        {
            return Err(OperationError::ContentChanged(
                "Skill root changed during discovery".into(),
            ));
        }
        Ok(SourcePackage {
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
#[async_trait]
impl SkillSource for FilesystemSkillSource {
    fn source_id(&self) -> &str {
        "local-standard"
    }
    async fn discover(&self, scope: &SkillScope) -> Result<SkillSourceInventory, OperationError> {
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
            let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(io_error)?;
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
                match self.package(&root, &path, project, format!("{label}/{name}")) {
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
    async fn read(
        &self,
        scope: &SkillScope,
        package: &SourcePackage,
        path: &str,
    ) -> Result<Vec<u8>, OperationError> {
        validate_relative(path, false)?;
        // Rediscover through configured roots, never accept the locator as arbitrary filesystem authority.
        let current = self
            .discover(scope)
            .await?
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
        )?;
        let after = self
            .discover(scope)
            .await?
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
fn scan_resources(
    entry: &Path,
    path: &Path,
    anchor: &Path,
    seen: &mut BTreeSet<PathBuf>,
    resources: &mut Vec<SourceResource>,
    total_bytes: &mut usize,
) -> Result<(), OperationError> {
    let canonical = path.canonicalize().map_err(io_error)?;
    if !canonical.starts_with(anchor) {
        return Err(OperationError::InvalidInput(
            "Skill resource symlink escapes its package root".into(),
        ));
    }
    if canonical.is_dir() {
        if !seen.insert(canonical.clone()) {
            return Err(OperationError::InvalidInput(
                "Skill resource graph contains a directory cycle".into(),
            ));
        }
        if seen.len() > 64 || resources.len() > MAX_RESOURCES {
            return Err(OperationError::BudgetExceeded(
                "Skill package traversal exceeds 2000 paths".into(),
            ));
        }
        let mut entries = fs::read_dir(path)
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        entries.sort_by_key(|e| e.file_name());
        for child in entries {
            let name = child.file_name();
            if matches!(name.to_str(), Some(".git" | "node_modules" | "target")) {
                continue;
            }
            scan_resources(entry, &child.path(), anchor, seen, resources, total_bytes)?;
        }
        seen.remove(&canonical);
    } else {
        if resources.len() >= MAX_RESOURCES {
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
        let (bytes, identity, _) = read_checked(path, anchor, MAX_SKILL_BYTES)?;
        *total_bytes += bytes.len();
        if *total_bytes > MAX_SOURCE_BYTES {
            return Err(OperationError::BudgetExceeded(
                "Skill package content exceeds 64 MiB".into(),
            ));
        }
        resources.push(SourceResource {
            path: relative,
            sha256: hash(&bytes),
            byte_size: bytes.len() as u64,
            identity,
        });
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
) -> Result<(Vec<u8>, String, PathBuf), OperationError> {
    let canonical = path.canonicalize().map_err(io_error)?;
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
