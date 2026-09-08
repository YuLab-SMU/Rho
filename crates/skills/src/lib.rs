#![forbid(unsafe_code)]
//! Standard method discovery/read semantics. External platforms still choose and execute methods.
mod query;
mod resolve;
use async_trait::async_trait;
pub use query::{SkillQueryHandler, SkillQueryKind};
pub use resolve::{MethodBindingPort, SkillCapabilityPort};
use rho_contract::*;
use rho_operation::{Clock, OperationError, SystemClock};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub const MAX_SKILL_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_RESOURCES: usize = 2000;
pub const MAX_PACKAGES: usize = 2000;
pub const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillScope {
    pub project_root: String,
    pub working_directory: String,
    pub principal: String,
}
#[derive(Debug, Clone)]
pub struct SourceResource {
    pub path: String,
    pub sha256: String,
    pub byte_size: u64,
    /// Includes native resolved identity; source adapters must fence symlink replacements.
    pub identity: String,
}
/// Parsing authority comes from a trusted source adapter, never from Skill content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillMetadataPolicy {
    Standard,
    HostAttested,
}
#[derive(Debug, Clone)]
pub struct SourcePackage {
    pub metadata_policy: SkillMetadataPolicy,
    pub source_id: String,
    pub key: String,
    /// Same canonical resource can retain relationships to independent sources.
    pub canonical_resource: String,
    pub location: String,
    pub enablement: SkillEnablement,
    pub reason: Option<String>,
    pub frontmatter: String,
    pub resources: Vec<SourceResource>,
}
#[derive(Debug, Clone, Default)]
pub struct SkillSourceInventory {
    pub packages: Vec<SourcePackage>,
    pub notices: Vec<SkillSourceNotice>,
}
#[async_trait]
pub trait SkillSource: Send + Sync {
    fn source_id(&self) -> &str;
    /// Only metadata and hashes: source code and resource content are not executed or interpreted.
    async fn discover(&self, scope: &SkillScope) -> Result<SkillSourceInventory, OperationError>;
    /// The adapter compares every package resource identity before and after the bounded read.
    async fn read(
        &self,
        scope: &SkillScope,
        package: &SourcePackage,
        path: &str,
    ) -> Result<Vec<u8>, OperationError>;
}
#[derive(Clone)]
pub(crate) struct DiscoveredSkill {
    pub summary: SkillSummary,
    pub package: SourcePackage,
    pub source: Arc<dyn SkillSource>,
}
pub struct SkillOwner {
    project_root: String,
    sources: Vec<Arc<dyn SkillSource>>,
    bindings: Arc<dyn MethodBindingPort>,
    capabilities: Arc<dyn SkillCapabilityPort>,
}
impl SkillOwner {
    pub fn new(
        project_root: String,
        sources: Vec<Arc<dyn SkillSource>>,
        bindings: Arc<dyn MethodBindingPort>,
        capabilities: Arc<dyn SkillCapabilityPort>,
    ) -> Result<Self, OperationError> {
        if project_root.is_empty() || sources.len() > 32 {
            return Err(OperationError::InvalidInput(
                "Skills need a canonical project and at most 32 trusted sources".into(),
            ));
        }
        let ids: BTreeSet<_> = sources.iter().map(|s| s.source_id()).collect();
        if ids.len() != sources.len() {
            return Err(OperationError::InvalidInput(
                "Skill source IDs must be unique".into(),
            ));
        }
        Ok(Self {
            project_root,
            sources,
            bindings,
            capabilities,
        })
    }
    pub fn project_root(&self) -> &str {
        &self.project_root
    }
    pub(crate) fn scope(
        &self,
        context: &CallContext,
        working_directory: &str,
    ) -> Result<SkillScope, OperationError> {
        validate_relative(working_directory, true)?;
        Ok(SkillScope {
            project_root: self.project_root.clone(),
            working_directory: working_directory.into(),
            principal: serde_json::to_string(context.principal()).map_err(invalid)?,
        })
    }
    pub(crate) async fn discover(
        &self,
        scope: &SkillScope,
    ) -> Result<(Vec<DiscoveredSkill>, Vec<SkillSourceNotice>), OperationError> {
        let mut skills = vec![];
        let mut notices = vec![];
        for source in &self.sources {
            let inventory = source.discover(scope).await?;
            if inventory.packages.len() > MAX_PACKAGES {
                return Err(OperationError::BudgetExceeded(
                    "Skill source exceeds 2000 packages; reduce its configured scope".into(),
                ));
            }
            notices.extend(inventory.notices);
            for mut package in inventory.packages {
                if package.source_id != source.source_id() {
                    return Err(OperationError::InvalidInput(
                        "Skill source returned a different provider identity".into(),
                    ));
                }
                package.resources.sort_by(|a, b| a.path.cmp(&b.path));
                let metadata =
                    match parse_frontmatter_for(&package.frontmatter, package.metadata_policy) {
                        Ok(metadata) => metadata,
                        Err(error) => {
                            notices.push(SkillSourceNotice {
                                source_id: package.source_id.clone(),
                                location: package.location.clone(),
                                code: "invalid_skill".into(),
                                message: error.to_string(),
                            });
                            continue;
                        }
                    };
                if package.resources.len() > MAX_RESOURCES {
                    return Err(OperationError::BudgetExceeded(
                        "Skill resource manifest exceeds 2000 entries".into(),
                    ));
                }
                let entry = package
                    .resources
                    .iter()
                    .find(|r| r.path == "SKILL.md")
                    .ok_or_else(|| {
                        OperationError::InvalidInput(
                            "Skill source omitted SKILL.md identity".into(),
                        )
                    })?;
                let manifest_digest = package_digest(&package);
                let source_ref = source_ref(&package);
                let scope_identity =
                    hash(format!("{}\0{}", scope.project_root, scope.principal).as_bytes());
                let skill_ref = format!(
                    "{}:{}:{}",
                    source_ref,
                    &scope_identity[7..23],
                    &manifest_digest[7..]
                );
                let relation = relation(&package);
                skills.push(DiscoveredSkill {
                    summary: SkillSummary {
                        skill_ref,
                        available: relation.enablement == SkillEnablement::Enabled,
                        unavailable_reasons: if relation.enablement == SkillEnablement::Enabled {
                            vec![]
                        } else {
                            vec![relation.reason.clone().unwrap_or_else(|| {
                                "The source disabled or rejected this Skill".into()
                            })]
                        },
                        source: relation,
                        metadata,
                        skill_digest: entry.sha256.clone(),
                        manifest_digest,
                        resource_count: package.resources.len() as u32,
                        equivalent_sources: vec![],
                    },
                    package,
                    source: source.clone(),
                });
            }
        }
        skills.sort_by(|a, b| {
            a.summary
                .source
                .source_ref
                .cmp(&b.summary.source.source_ref)
        });
        // Preserve every source-qualified entry and its enabled state, even for the same resource.
        for i in 0..skills.len() {
            let equivalent = skills
                .iter()
                .enumerate()
                .filter(|(j, s)| {
                    *j != i && s.package.canonical_resource == skills[i].package.canonical_resource
                })
                .map(|(_, s)| s.summary.source.clone())
                .collect();
            skills[i].summary.equivalent_sources = equivalent;
            let denied: Vec<_> = skills[i]
                .summary
                .equivalent_sources
                .iter()
                .filter(|r| {
                    r.enablement != SkillEnablement::Enabled && r.source_id != "local-standard"
                })
                .map(|r| {
                    format!(
                        "Equivalent resource is disabled or rejected by {}: {}",
                        r.source_id,
                        r.reason.as_deref().unwrap_or("host source policy")
                    )
                })
                .collect();
            if !denied.is_empty() {
                skills[i].summary.available = false;
                skills[i].summary.unavailable_reasons.extend(denied);
            }
        }
        let bytes = serde_json::to_vec(&skills.iter().map(|s| &s.summary).collect::<Vec<_>>())
            .map_err(invalid)?
            .len();
        if bytes > MAX_MANIFEST_BYTES {
            return Err(OperationError::BudgetExceeded(
                "Skill metadata exceeds 8 MiB; narrow the configured source scope".into(),
            ));
        }
        Ok((skills, notices))
    }
    pub async fn list(
        &self,
        context: &CallContext,
        arguments: &SkillListArguments,
    ) -> Result<SkillListPage, OperationError> {
        let scope = self.scope(context, &arguments.working_directory)?;
        let (skills, notices) = self.discover(&scope).await?;
        list_page(&scope, arguments, &skills, notices)
    }
    pub async fn read(
        &self,
        context: &CallContext,
        arguments: &SkillReadArguments,
    ) -> Result<SkillReadPage, OperationError> {
        let scope = self.scope(context, &arguments.working_directory)?;
        let (skills, _) = self.discover(&scope).await?;
        let skill = skills.iter().find(|s| s.summary.skill_ref == arguments.skill_ref).ok_or_else(|| OperationError::ContentChanged("Skill observation changed or does not belong to this principal/project/workdir; list again".into()))?;
        if !skill.summary.available {
            return Err(OperationError::Unavailable(
                skill
                    .summary
                    .source
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Host disabled or rejected this Skill".into()),
            ));
        }
        if arguments.expected_digest != skill.summary.skill_digest {
            return Err(OperationError::ContentChanged(
                "SKILL.md no longer matches the expected digest".into(),
            ));
        }
        let mut page = SkillReadPage {
            skill_ref: arguments.skill_ref.clone(),
            source_ref: skill.summary.source.source_ref.clone(),
            skill_digest: skill.summary.skill_digest.clone(),
            manifest_digest: skill.summary.manifest_digest.clone(),
            kind: arguments.kind,
            resource: None,
            resources: vec![],
            text: None,
            bytes: None,
            offset: arguments.offset,
            next_offset: None,
            complete: true,
            observed_at_ms: SystemClock.now_ms()?,
        };
        let start = usize::try_from(arguments.offset).map_err(invalid)?;
        if matches!(arguments.kind, SkillReadKind::Manifest) {
            if start > skill.package.resources.len() {
                return Err(OperationError::InvalidInput(
                    "Resource entry offset exceeds manifest length".into(),
                ));
            }
            let mut end =
                (start + arguments.resource_limit as usize).min(skill.package.resources.len());
            loop {
                page.resources = skill.package.resources[start..end]
                    .iter()
                    .map(|r| resource_summary(skill, r))
                    .collect();
                if serde_json::to_vec(&page).map_err(invalid)?.len() <= 65536 {
                    break;
                }
                if end <= start + 1 {
                    return Err(OperationError::BudgetExceeded(
                        "One resource entry exceeds the manifest page budget".into(),
                    ));
                }
                end -= 1;
            }
            page.next_offset = (end < skill.package.resources.len()).then_some(end as u64);
        } else {
            let path = arguments.resource_path.as_deref().unwrap_or("SKILL.md");
            validate_relative(path, false)?;
            let resource = skill
                .package
                .resources
                .iter()
                .find(|r| r.path == path)
                .ok_or_else(|| {
                    OperationError::InvalidInput(
                        "Resource is absent from this Skill manifest".into(),
                    )
                })?;
            let expected = if path == "SKILL.md" {
                &arguments.expected_digest
            } else {
                arguments.expected_resource_digest.as_ref().ok_or_else(|| {
                    OperationError::InvalidInput(
                        "Package resources require expected_resource_digest from the manifest"
                            .into(),
                    )
                })?
            };
            if expected != &resource.sha256 {
                return Err(OperationError::ContentChanged(
                    "Skill resource digest changed".into(),
                ));
            }
            let bytes = skill.source.read(&scope, &skill.package, path).await?;
            if hash(&bytes) != resource.sha256 || bytes.len() as u64 != resource.byte_size {
                return Err(OperationError::ContentChanged(
                    "Skill source returned different resource bytes".into(),
                ));
            }
            if start > bytes.len() {
                return Err(OperationError::InvalidInput(
                    "Resource byte offset exceeds content length".into(),
                ));
            }
            let mut end = (start + arguments.limit_bytes as usize).min(bytes.len());
            if matches!(arguments.kind, SkillReadKind::Text) {
                let text = std::str::from_utf8(&bytes).map_err(|_| {
                    OperationError::InvalidInput(
                        "Resource is not UTF-8 text; read kind=bytes preserves original bytes"
                            .into(),
                    )
                })?;
                if !text.is_char_boundary(start) {
                    return Err(OperationError::InvalidInput(
                        "Text offset must be a UTF-8 character boundary".into(),
                    ));
                }
                while end > start && !text.is_char_boundary(end) {
                    end -= 1;
                }
                if end == start && start < bytes.len() {
                    return Err(OperationError::BudgetExceeded(
                        "Next UTF-8 character exceeds limit_bytes; request at least 4 bytes".into(),
                    ));
                }
                page.text = Some(text[start..end].into());
            } else {
                page.bytes = Some(bytes[start..end].to_vec());
            }
            page.next_offset = (end < bytes.len()).then_some(end as u64);
            page.resource = Some(resource_summary(skill, resource));
            self.bindings
                .record_skill_read(
                    context,
                    &ApplicationSkillReadReceipt {
                        working_directory: scope.working_directory,
                        skill_ref: arguments.skill_ref.clone(),
                        source_ref: page.source_ref.clone(),
                        resource_ref: page.resource.as_ref().unwrap().resource_ref.clone(),
                        sha256: resource.sha256.clone(),
                        external_task_ref: arguments.external_task_ref.clone(),
                        observed_at_ms: page.observed_at_ms as u64,
                    },
                )
                .await
                .map_err(OperationError::Unavailable)?;
        }
        page.complete = page.next_offset.is_none();
        Ok(page)
    }
}

pub fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub fn package_digest(package: &SourcePackage) -> String {
    let mut h = Sha256::new();
    h.update(package.canonical_resource.as_bytes());
    h.update(format!("{:?}", package.metadata_policy).as_bytes());
    h.update(format!("{:?}", package.enablement).as_bytes());
    for r in &package.resources {
        for part in [&r.path, &r.sha256, &r.identity] {
            h.update((part.len() as u64).to_be_bytes());
            h.update(part.as_bytes());
        }
    }
    format!("sha256:{:x}", h.finalize())
}
pub fn source_ref(package: &SourcePackage) -> String {
    format!(
        "skill-source:{}",
        &hash(format!("{}\0{}", package.source_id, package.key).as_bytes())[7..]
    )
}
fn relation(p: &SourcePackage) -> SkillSourceRelation {
    SkillSourceRelation {
        source_id: p.source_id.clone(),
        source_ref: source_ref(p),
        location: p.location.clone(),
        enablement: p.enablement.clone(),
        reason: p.reason.clone(),
    }
}
fn resource_summary(skill: &DiscoveredSkill, r: &SourceResource) -> SkillResourceSummary {
    SkillResourceSummary {
        resource_ref: format!("{}#{}", skill.summary.source.source_ref, r.path),
        path: r.path.clone(),
        sha256: r.sha256.clone(),
        byte_size: r.byte_size,
        kind: if r.path == "SKILL.md" {
            "instructions"
        } else if r.path.starts_with("scripts/") {
            "script"
        } else if r.path.starts_with("references/") {
            "reference"
        } else {
            "asset"
        }
        .into(),
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
pub fn validate_relative(path: &str, allow_root: bool) -> Result<(), OperationError> {
    if allow_root && path == "." {
        return Ok(());
    }
    if path.is_empty()
        || path.len() > 4096
        || path.contains(['\\', '\0', ':'])
        || path.starts_with('/')
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(OperationError::InvalidInput(
            "Expected a normalized, contained relative path".into(),
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
struct Frontmatter {
    name: serde_json::Value,
    description: serde_json::Value,
    license: Option<serde_json::Value>,
    compatibility: Option<serde_json::Value>,
    #[serde(default = "empty_metadata")]
    metadata: serde_json::Value,
    #[serde(rename = "allowed-tools")]
    allowed_tools: Option<serde_json::Value>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}
fn empty_metadata() -> serde_json::Value {
    serde_json::json!({})
}
pub fn parse_frontmatter(text: &str) -> Result<SkillMetadata, OperationError> {
    parse_frontmatter_for(text, SkillMetadataPolicy::Standard)
}
pub fn parse_frontmatter_for(
    text: &str,
    policy: SkillMetadataPolicy,
) -> Result<SkillMetadata, OperationError> {
    if text.len() > MAX_FRONTMATTER_BYTES {
        return Err(OperationError::BudgetExceeded(
            "Skill frontmatter exceeds 64 KiB".into(),
        ));
    }
    let mut f: Frontmatter = yaml_serde::from_str(text).map_err(invalid)?;
    let name = f.name.as_str().ok_or_else(|| {
        OperationError::InvalidInput("Skill name must be explicitly declared as YAML text".into())
    })?;
    let description = f.description.as_str().ok_or_else(|| {
        OperationError::InvalidInput(
            "Skill description must be explicitly declared as YAML text".into(),
        )
    })?;
    let standard_name = !name.is_empty()
        && name.chars().count() <= 64
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .chars()
            .all(|c| c.is_lowercase() || c.is_numeric() || c == '-');
    if policy == SkillMetadataPolicy::Standard {
        if !standard_name
            || description.trim().is_empty()
            || description.chars().count() > 1024
            || f.compatibility
                .as_ref()
                .is_some_and(|v| v.as_str().is_none_or(|s| s.chars().count() > 500))
            || f.license.as_ref().is_some_and(|v| !v.is_string())
            || f.allowed_tools.as_ref().is_some_and(|v| !v.is_string())
            || !f
                .metadata
                .as_object()
                .is_some_and(|m| m.values().all(|v| v.is_string()))
        {
            return Err(OperationError::InvalidInput(
                "Invalid standard Skill frontmatter name, description, optional fields or metadata"
                    .into(),
            ));
        }
    } else if name.trim().is_empty()
        || name.len() > 1024
        || name.chars().any(char::is_control)
        || description.trim().is_empty()
        || description.len() > 16384
        || description
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(OperationError::InvalidInput(
            "Attested host Skill names/descriptions must be nonempty, bounded and control-safe"
                .into(),
        ));
    }
    // Preserve optional provider fields as raw data when they do not use the standard textual form.
    let mut textual = |field: &str, value: Option<serde_json::Value>| -> Option<String> {
        match value {
            Some(serde_json::Value::String(text)) => Some(text),
            Some(raw) => {
                f.extra.insert(field.into(), raw);
                None
            }
            None => None,
        }
    };
    let license = textual("license", f.license);
    let compatibility = textual("compatibility", f.compatibility);
    Ok(SkillMetadata {
        name: name.into(),
        description: description.into(),
        license,
        compatibility,
        metadata: f.metadata,
        allowed_tools: f.allowed_tools,
        extra: f.extra,
        dependencies: "undeclared".into(),
    })
}

fn list_page(
    scope: &SkillScope,
    args: &SkillListArguments,
    skills: &[DiscoveredSkill],
    notices: Vec<SkillSourceNotice>,
) -> Result<SkillListPage, OperationError> {
    let filter = args.filter.to_lowercase();
    let selected: Vec<_> = skills
        .iter()
        .filter(|s| {
            args.source_id
                .as_ref()
                .is_none_or(|id| *id == s.summary.source.source_id)
                && (filter.is_empty()
                    || format!(
                        "{} {}",
                        s.summary.metadata.name, s.summary.metadata.description
                    )
                    .to_lowercase()
                    .contains(&filter))
        })
        .map(|s| s.summary.clone())
        .collect();
    let stamp = hash(
        &serde_json::to_vec(&(
            scope.project_root.clone(),
            scope.working_directory.clone(),
            scope.principal.clone(),
            &selected,
            &notices,
        ))
        .map_err(invalid)?,
    );
    let (start, notice_start) = if let Some(cursor) = &args.cursor {
        let parts: Vec<_> = cursor.split('.').collect();
        if parts.len() != 3 || parts[0] != &stamp[7..] {
            return Err(OperationError::ContentChanged(
                "Skill catalog or source state changed; list from the first page".into(),
            ));
        }
        (
            parts[1].parse::<usize>().map_err(invalid)?,
            parts[2].parse::<usize>().map_err(invalid)?,
        )
    } else {
        (0, 0)
    };
    if start > selected.len() || notice_start > notices.len() {
        return Err(OperationError::InvalidInput(
            "Skill catalog cursor exceeds inventory".into(),
        ));
    }
    let mut end = (start + args.limit as usize).min(selected.len());
    let mut notice_end = (notice_start + 20).min(notices.len());
    let mut page = SkillListPage {
        working_directory: scope.working_directory.clone(),
        skills: vec![],
        total: selected.len() as u32,
        next_cursor: None,
        source_notices: vec![],
        notices_next_cursor: None,
        complete: false,
        observed_at_ms: SystemClock.now_ms()?,
    };
    loop {
        page.skills = selected[start..end].to_vec();
        page.source_notices = notices[notice_start..notice_end].to_vec();
        if serde_json::to_vec(&page).map_err(invalid)?.len() <= 63000 {
            break;
        }
        if notice_end > notice_start {
            notice_end -= 1;
        } else if end > start + 1 {
            end -= 1;
        } else {
            return Err(OperationError::BudgetExceeded(
                "One Skill metadata entry exceeds the 64 KiB catalog page bound".into(),
            ));
        }
    }
    if end < selected.len() || notice_end < notices.len() {
        page.next_cursor = Some(format!("{}.{}.{}", &stamp[7..], end, notice_end));
    }
    if notice_end < notices.len() {
        page.notices_next_cursor = page.next_cursor.clone();
    }
    page.complete = page.next_cursor.is_none() && notices.is_empty();
    Ok(page)
}
