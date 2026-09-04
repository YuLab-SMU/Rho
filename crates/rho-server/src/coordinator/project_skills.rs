fn bounded_project_skill_text(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push_str("... [truncated]");
    }
    output
}

#[cfg(test)]
const MAX_PROVIDER_FAILURE_BYTES: usize = 2 * 1024;

#[cfg(test)]
fn bounded_provider_failure(payload: &Value) -> String {
    let value = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Provider request failed without details.");
    let value = redact_sensitive_text(value);
    if value.len() <= MAX_PROVIDER_FAILURE_BYTES {
        return value;
    }
    let suffix = "... [truncated]";
    let mut end = MAX_PROVIDER_FAILURE_BYTES - suffix.len();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], suffix)
}

fn is_valid_project_skill_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn has_allowed_skill_extension(path: &str, allowed: &[&str]) -> bool {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            allowed
                .iter()
                .any(|candidate| value.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

fn is_sensitive_skill_path(path: &str) -> bool {
    let lowercase = path.replace('\\', "/").to_ascii_lowercase();
    lowercase.ends_with(".env")
        || lowercase.ends_with(".pem")
        || lowercase.ends_with(".key")
        || lowercase.contains("credentials")
        || lowercase.contains("/secrets")
}

fn ensure_not_project_skill_symlink(path: &Path, is_symlink: bool) -> Result<()> {
    ensure!(
        !is_symlink,
        "project skill path uses a symlink: {}",
        path.display()
    );
    Ok(())
}

fn ensure_path_without_symlinks(base: &Path, relative: &Path) -> Result<()> {
    let mut current = base.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).with_context(|| {
            format!(
                "reading project skill path metadata for {}",
                current.display()
            )
        })?;
        ensure_not_project_skill_symlink(&current, metadata.file_type().is_symlink())?;
    }
    Ok(())
}

fn ensure_project_skill_root_without_symlinks(
    project_root: &Path,
    skills_dir: &Path,
) -> Result<()> {
    let relative = Path::new(".rho").join("skills");
    if !skills_dir.exists() {
        return Ok(());
    }
    ensure_path_without_symlinks(project_root, &relative)
}

fn resolve_project_skill_text_file(
    skills_dir: &Path,
    relative: &str,
    allowed_extensions: &[&str],
    max_bytes: u64,
) -> Result<(String, String)> {
    ensure!(!relative.trim().is_empty(), "project skill path is empty");
    ensure!(
        !Path::new(relative).is_absolute(),
        "project skill paths must be relative to .rho/skills"
    );
    ensure!(
        !is_sensitive_skill_path(relative),
        "project skill path points at sensitive content: {relative}"
    );
    ensure!(
        has_allowed_skill_extension(relative, allowed_extensions),
        "project skill path has an unsupported file type: {relative}"
    );
    let relative_path = Path::new(relative);
    ensure!(
        !relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_))),
        "project skill path must stay within .rho/skills: {relative}"
    );
    ensure_path_without_symlinks(skills_dir, relative_path)?;
    let candidate = skills_dir.join(relative_path);
    let canonical_base = fs::canonicalize(skills_dir)
        .with_context(|| format!("canonicalizing {}", skills_dir.display()))?;
    let canonical_candidate = fs::canonicalize(&candidate)
        .with_context(|| format!("project skill file does not exist: {}", candidate.display()))?;
    ensure!(
        canonical_candidate.starts_with(&canonical_base),
        "project skill path escapes .rho/skills: {relative}"
    );
    let metadata = fs::metadata(&canonical_candidate).with_context(|| {
        format!(
            "reading project skill file metadata for {}",
            canonical_candidate.display()
        )
    })?;
    ensure!(
        metadata.is_file(),
        "project skill path must reference a file: {}",
        canonical_candidate.display()
    );
    ensure!(
        metadata.len() <= max_bytes,
        "project skill file is too large: {} bytes",
        metadata.len()
    );
    let content = fs::read_to_string(&canonical_candidate)
        .with_context(|| format!("reading {}", canonical_candidate.display()))?;
    Ok((
        relative.replace('\\', "/"),
        bounded_project_skill_text(&content, max_bytes as usize),
    ))
}

fn discover_project_skills(project_root: &str) -> ProjectSkillDiscovery {
    let mut discovery = ProjectSkillDiscovery {
        project_root: project_root.replace('\\', "/"),
        trust_status: PROJECT_SKILL_TRUST_STATUS.to_string(),
        skills: Vec::new(),
        discovery_error: None,
    };
    let result = (|| -> Result<Vec<ResolvedProjectSkill>> {
        let project_root = Path::new(project_root);
        let skills_dir = project_root.join(".rho").join("skills");
        ensure_project_skill_root_without_symlinks(project_root, &skills_dir)?;
        let manifest_path = skills_dir.join("manifest.json");
        if !manifest_path.exists() {
            return Ok(Vec::new());
        }
        let manifest_metadata = fs::symlink_metadata(&manifest_path)
            .with_context(|| format!("reading {}", manifest_path.display()))?;
        ensure_not_project_skill_symlink(
            &manifest_path,
            manifest_metadata.file_type().is_symlink(),
        )?;
        ensure!(
            manifest_metadata.len() <= MAX_PROJECT_SKILL_MANIFEST_BYTES,
            "project skill manifest is too large: {} bytes",
            manifest_metadata.len()
        );
        let manifest_text = fs::read_to_string(&manifest_path)
            .with_context(|| format!("reading {}", manifest_path.display()))?;
        let manifest: ProjectSkillManifest = serde_json::from_str(&manifest_text)
            .context("project skill manifest is not valid JSON")?;
        ensure!(
            manifest.schema_version == 1,
            "unsupported project skill schema_version `{}`",
            manifest.schema_version
        );
        ensure!(
            manifest.skills.len() <= MAX_PROJECT_SKILL_COUNT,
            "project skill manifest exceeds the supported skill count"
        );
        manifest
            .skills
            .into_iter()
            .map(|skill| {
                ensure!(
                    is_valid_project_skill_id(&skill.id),
                    "invalid project skill id `{}`",
                    skill.id
                );
                ensure!(
                    !skill.title.trim().is_empty() && skill.title.chars().count() <= 80,
                    "project skill title is missing or too long for `{}`",
                    skill.id
                );
                if let Some(description) = &skill.description {
                    ensure!(
                        description.chars().count() <= 280,
                        "project skill description is too long for `{}`",
                        skill.id
                    );
                }
                ensure!(
                    skill.references.len() <= MAX_PROJECT_SKILL_REFERENCES,
                    "project skill references exceed the supported limit for `{}`",
                    skill.id
                );
                let (instructions_path, instructions) = resolve_project_skill_text_file(
                    &skills_dir,
                    &skill.instructions_path,
                    &["md", "txt"],
                    MAX_PROJECT_SKILL_INSTRUCTION_BYTES,
                )?;
                let references = skill
                    .references
                    .iter()
                    .map(|reference| {
                        let (path, content) = resolve_project_skill_text_file(
                            &skills_dir,
                            reference,
                            &["json", "yaml", "yml", "txt", "csv", "tsv", "md"],
                            MAX_PROJECT_SKILL_REFERENCE_BYTES,
                        )?;
                        Ok(ResolvedProjectSkillReference { path, content })
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(ResolvedProjectSkill {
                    id: skill.id,
                    title: skill.title,
                    description: skill.description,
                    trust_status: PROJECT_SKILL_TRUST_STATUS.to_string(),
                    instructions_path,
                    instructions,
                    references,
                })
            })
            .collect::<Result<Vec<_>>>()
    })();
    match result {
        Ok(skills) => discovery.skills = skills,
        Err(error) => discovery.discovery_error = Some(error.to_string()),
    }
    discovery
}
pub fn discover_project_skill_summaries(project_root: &str) -> ProjectSkillDiscoverySummary {
    let discovery = discover_project_skills(project_root);
    ProjectSkillDiscoverySummary {
        project_root: discovery.project_root,
        trust_status: discovery.trust_status,
        skills: discovery
            .skills
            .into_iter()
            .map(|skill| ProjectSkillSummary {
                id: skill.id,
                title: skill.title,
                description: skill.description,
                trust_status: skill.trust_status,
                instructions_path: skill.instructions_path,
                references: skill
                    .references
                    .into_iter()
                    .map(|reference| reference.path)
                    .collect(),
            })
            .collect(),
        discovery_error: discovery.discovery_error,
    }
}
