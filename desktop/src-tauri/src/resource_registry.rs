use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, MutexGuard};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, ensure};
use rho_ui_contract::{
    RESOURCE_CONTENT_CONTRACT, RESOURCE_REGISTRY_SNAPSHOT_CONTRACT, RSR_CONTRACT_MAJOR,
    ResourceBindingV1, ResourceCapabilityId, ResourceContentV1, ResourceDeleteRequestV1,
    ResourceDescriptorV1, ResourceDraftRequestV1, ResourceKindId, ResourceProviderId,
    ResourceProviderRegistrationV1, ResourceReadConsistencyV1, ResourceReadRequestV1,
    ResourceRegistrySnapshotV1, ResourceReloadRequestV1, ResourceRenameRequestV1,
    ResourceResolveRequestV1, ResourceSaveRequestV1, ResourceStatusV1, ResourceTargetV1, Validate,
    next_revision,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::project::{
    atomic_write, ensure_editable_content_size, ensure_editable_file, ensure_editable_file_size,
    list_project_files, project_path,
};
use crate::{AppState, display_error};

pub(crate) const RESOURCE_REGISTRY_CHANGED_EVENT: &str = "rho://resource-registry-changed";
const PROJECT_FILE_PROVIDER: &str = "rho.project-files";
const PROJECT_FILE_KIND: &str = "project_file";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectCursor {
    project_id: rho_ui_contract::ProjectId,
    project_revision: u64,
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSignature {
    size_bytes: u64,
    modified_nanos: u128,
}

#[derive(Debug, Clone)]
struct ResourceEntry {
    descriptor: ResourceDescriptorV1,
    signature: Option<FileSignature>,
}

#[derive(Debug, Clone)]
struct DocumentState {
    content: String,
    base_content: String,
    document_revision: u64,
    base_resource_revision: u64,
    dirty: bool,
}

#[derive(Default)]
struct ProjectResources {
    root: PathBuf,
    entries: BTreeMap<String, ResourceEntry>,
    documents: BTreeMap<String, DocumentState>,
}

#[derive(Default)]
struct ResourceRegistryInner {
    snapshot_revision: u64,
    current: Option<ProjectCursor>,
    providers: Vec<ResourceProviderRegistrationV1>,
    projects: BTreeMap<rho_ui_contract::ProjectId, ProjectResources>,
}

#[derive(Default)]
pub(crate) struct ResourceRegistryState {
    inner: StdMutex<ResourceRegistryInner>,
    operation_gate: Mutex<()>,
}

#[derive(Clone)]
pub(crate) struct ResourceTransition {
    pub(crate) snapshot: ResourceRegistrySnapshotV1,
    pub(crate) reason: &'static str,
    pub(crate) changed: bool,
}

#[derive(Clone, Serialize)]
struct ResourceRegistryChangedEvent<'a> {
    reason: &'a str,
    snapshot_revision: u64,
    project_id: &'a rho_ui_contract::ProjectId,
    project_revision: u64,
}

fn normalized_resource_id(value: &str) -> Result<String> {
    let value = value.replace('\\', "/");
    ensure!(!value.is_empty(), "Resource path must not be empty");
    ensure!(
        !value.starts_with('/'),
        "Resource path must be project-relative"
    );
    ensure!(
        !value.chars().any(char::is_control),
        "Resource path contains control characters"
    );
    let segments = value.split('/').collect::<Vec<_>>();
    ensure!(
        segments
            .iter()
            .all(|segment| !segment.is_empty() && *segment != "." && *segment != ".."),
        "Resource path must be normalized"
    );
    #[cfg(windows)]
    ensure!(
        !segments[0].contains(':'),
        "Resource path must not contain a drive prefix"
    );
    Ok(segments.join("/"))
}

fn file_signature(path: &Path) -> Result<FileSignature> {
    let metadata = path.metadata()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    Ok(FileSignature {
        size_bytes: metadata.len(),
        modified_nanos,
    })
}

fn content_sha256(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn supports(entry: &ResourceEntry, capability: &str) -> bool {
    entry
        .descriptor
        .capabilities
        .iter()
        .any(|candidate| candidate.as_str() == capability)
}

fn media_type(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let extension = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    match extension {
        "html" => Some("text/html"),
        "md" | "qmd" => Some("text/markdown"),
        "r" => Some("text/x-r"),
        "rmd" => Some("text/x-r-markdown"),
        "txt" | "log" => Some("text/plain"),
        "json" => Some("application/json"),
        "csv" => Some("text/csv"),
        "tsv" => Some("text/tab-separated-values"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "yaml" | "yml" => Some("application/yaml"),
        "toml" => Some("application/toml"),
        "css" => Some("text/css"),
        "js" | "jsx" => Some("text/javascript"),
        "ts" | "tsx" => Some("text/typescript"),
        "sql" => Some("application/sql"),
        _ if matches!(name.as_str(), "description" | "namespace" | "news") => Some("text/plain"),
        _ => None,
    }
}

fn preview_supported(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "html"
            | "md"
            | "r"
            | "rmd"
            | "txt"
            | "log"
            | "json"
            | "csv"
            | "tsv"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
    )
}

fn capabilities(path: &str, editable: bool) -> Vec<ResourceCapabilityId> {
    let mut capabilities = vec![
        ResourceCapabilityId::new("resource.read.snapshot")
            .expect("built-in Resource capability must be valid"),
    ];
    if editable {
        for capability in [
            "resource.read.document",
            "resource.write",
            "resource.rename",
            "resource.delete",
        ] {
            capabilities.push(
                ResourceCapabilityId::new(capability)
                    .expect("built-in Resource capability must be valid"),
            );
        }
    }
    if preview_supported(path) {
        capabilities.push(
            ResourceCapabilityId::new("resource.preview")
                .expect("built-in Resource capability must be valid"),
        );
    }
    capabilities.sort();
    capabilities
}

fn descriptor_for_file(
    project_id: &rho_ui_contract::ProjectId,
    path: &str,
    revision: u64,
    status: ResourceStatusV1,
    signature: Option<&FileSignature>,
    digest: Option<String>,
    editable: bool,
) -> Result<ResourceDescriptorV1> {
    let descriptor = ResourceDescriptorV1 {
        resource_provider_id: ResourceProviderId::new(PROJECT_FILE_PROVIDER)?,
        project_id: project_id.clone(),
        resource_kind: ResourceKindId::new(PROJECT_FILE_KIND)?,
        resource_id: path.to_string(),
        resource_revision: revision,
        label: path.rsplit('/').next().unwrap_or(path).to_string(),
        capabilities: capabilities(path, editable),
        status,
        media_type: (status == ResourceStatusV1::Ready)
            .then(|| media_type(path).unwrap_or("text/plain").to_string()),
        size_bytes: (status == ResourceStatusV1::Ready)
            .then(|| signature.map_or(0, |value| value.size_bytes)),
        content_sha256: (status == ResourceStatusV1::Ready)
            .then_some(digest)
            .flatten(),
    };
    descriptor.validate()?;
    Ok(descriptor)
}

fn next_entry_for_path(
    project_id: &rho_ui_contract::ProjectId,
    resource_id: &str,
    path: &Path,
    previous: Option<&ResourceEntry>,
) -> Result<ResourceEntry> {
    let (status, signature, editable) = if path.is_file() {
        let editable = ensure_editable_file(path).is_ok();
        let status = if editable || preview_supported(resource_id) {
            ResourceStatusV1::Ready
        } else {
            ResourceStatusV1::Unsupported
        };
        (status, Some(file_signature(path)?), editable)
    } else {
        (ResourceStatusV1::Missing, None, false)
    };
    let unchanged = previous
        .is_some_and(|entry| entry.signature == signature && entry.descriptor.status == status);
    let revision = match previous {
        None => 1,
        Some(entry) if unchanged => entry.descriptor.resource_revision,
        Some(entry) => next_revision(
            "resource.resource_revision",
            entry.descriptor.resource_revision,
        )?,
    };
    let digest = previous
        .filter(|_| unchanged)
        .and_then(|entry| entry.descriptor.content_sha256.clone());
    Ok(ResourceEntry {
        descriptor: descriptor_for_file(
            project_id,
            resource_id,
            revision,
            status,
            signature.as_ref(),
            digest,
            editable,
        )?,
        signature,
    })
}

impl ResourceRegistryState {
    fn inner(&self) -> MutexGuard<'_, ResourceRegistryInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn bump(inner: &mut ResourceRegistryInner) -> Result<()> {
        inner.snapshot_revision = next_revision(
            "resource_registry.snapshot_revision",
            inner.snapshot_revision,
        )?;
        Ok(())
    }

    fn snapshot(inner: &ResourceRegistryInner) -> Result<ResourceRegistrySnapshotV1> {
        let current = inner
            .current
            .as_ref()
            .context("Resource Registry has no project context")?;
        let project = inner
            .projects
            .get(&current.project_id)
            .context("Resource Registry current project cache is unavailable")?;
        let snapshot = ResourceRegistrySnapshotV1 {
            contract: RESOURCE_REGISTRY_SNAPSHOT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            snapshot_revision: inner.snapshot_revision,
            project_id: current.project_id.clone(),
            project_revision: current.project_revision,
            providers: inner.providers.clone(),
            resources: project
                .entries
                .values()
                .map(|entry| entry.descriptor.clone())
                .collect(),
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    fn transition(
        inner: &ResourceRegistryInner,
        reason: &'static str,
        changed: bool,
    ) -> Result<ResourceTransition> {
        Ok(ResourceTransition {
            snapshot: Self::snapshot(inner)?,
            reason,
            changed,
        })
    }

    fn reconcile(
        &self,
        project_id: rho_ui_contract::ProjectId,
        project_revision: u64,
        root: PathBuf,
        providers: Vec<ResourceProviderRegistrationV1>,
    ) -> Result<ResourceTransition> {
        let files = list_project_files(&root)?;
        let mut inner = self.inner();
        let cursor = ProjectCursor {
            project_id: project_id.clone(),
            project_revision,
            root: root.clone(),
        };
        let cursor_changed = inner.current.as_ref() != Some(&cursor);
        let providers_changed = inner.providers != providers;
        inner.current = Some(cursor);
        inner.providers = providers;
        let project = inner.projects.entry(project_id.clone()).or_default();
        ensure!(
            project.root.as_os_str().is_empty() || project.root == root,
            "Resource project identity was reused for another root"
        );
        project.root = root.clone();
        let before = project
            .entries
            .values()
            .map(|entry| entry.descriptor.clone())
            .collect::<Vec<_>>();
        let mut observed = BTreeSet::new();
        for file in files.files {
            let resource_id = normalized_resource_id(&file.path)?;
            if resource_id
                .rsplit('/')
                .next()
                .is_some_and(|name| name.starts_with(".rho-delete-") && name.ends_with(".tmp"))
            {
                continue;
            }
            let path = project_path(&root, &resource_id)?;
            observed.insert(resource_id.clone());
            let entry = next_entry_for_path(
                &project_id,
                &resource_id,
                &path,
                project.entries.get(&resource_id),
            )?;
            project.entries.insert(resource_id, entry);
        }
        let retained_ids = project.entries.keys().cloned().collect::<Vec<_>>();
        for resource_id in retained_ids {
            if observed.contains(&resource_id) {
                continue;
            }
            let path = project_path(&root, &resource_id)?;
            let entry = next_entry_for_path(
                &project_id,
                &resource_id,
                &path,
                project.entries.get(&resource_id),
            )?;
            project.entries.insert(resource_id, entry);
        }
        let after = project
            .entries
            .values()
            .map(|entry| entry.descriptor.clone())
            .collect::<Vec<_>>();
        let changed =
            inner.snapshot_revision == 0 || cursor_changed || providers_changed || before != after;
        if changed {
            Self::bump(&mut inner)?;
        }
        Self::transition(&inner, "resources_reconciled", changed)
    }

    fn resolve_path(&self, request: &ResourceResolveRequestV1) -> Result<ResourceTransition> {
        request.validate()?;
        let mut inner = self.inner();
        let current = inner
            .current
            .clone()
            .context("Resource Registry has no project context")?;
        ensure!(
            current.project_id == request.project_id,
            "Resource belongs to another project"
        );
        ensure!(
            current.project_revision == request.expected_project_revision
                && inner.snapshot_revision == request.expected_snapshot_revision,
            "Resource resolve request is stale"
        );
        ensure!(
            request.resource_provider_id.as_str() == PROJECT_FILE_PROVIDER,
            "Unknown Resource Provider"
        );
        ensure!(
            request.resource_kind.as_str() == PROJECT_FILE_KIND,
            "Unsupported Resource kind"
        );
        let resource_id = normalized_resource_id(&request.resource_id)?;
        let project = inner.projects.get_mut(&current.project_id).unwrap();
        if project.entries.contains_key(&resource_id) {
            return Self::transition(&inner, "resource_resolved", false);
        }
        ensure!(
            project.entries.len() < rho_ui_contract::MAX_RESOURCE_INSTANCES,
            "Resource Registry budget is exhausted"
        );
        let path = project_path(&current.root, &resource_id)?;
        let entry = next_entry_for_path(&current.project_id, &resource_id, &path, None)?;
        project.entries.insert(resource_id, entry);
        Self::bump(&mut inner)?;
        Self::transition(&inner, "resource_resolved", true)
    }

    fn target(
        inner: &ResourceRegistryInner,
        target: &ResourceTargetV1,
        exact_revision: bool,
    ) -> Result<ResourceEntry> {
        target.validate()?;
        let current = inner
            .current
            .as_ref()
            .context("Resource Registry has no project context")?;
        ensure!(
            current.project_id == target.project_id,
            "Resource request belongs to another project"
        );
        ensure!(
            current.project_revision == target.expected_project_revision,
            "Resource project revision is stale"
        );
        ensure!(
            target.resource_provider_id.as_str() == PROJECT_FILE_PROVIDER,
            "Unknown Resource Provider"
        );
        ensure!(
            target.resource_kind.as_str() == PROJECT_FILE_KIND,
            "Unsupported Resource kind"
        );
        let resource_id = normalized_resource_id(&target.resource_id)?;
        let entry = inner
            .projects
            .get(&current.project_id)
            .and_then(|project| project.entries.get(&resource_id))
            .context("Resource was not resolved")?;
        if exact_revision {
            ensure!(
                entry.descriptor.resource_revision == target.expected_resource_revision,
                "Resource revision is stale"
            );
        }
        Ok(entry.clone())
    }

    pub(crate) fn validate_surface_binding(
        &self,
        project_id: &rho_ui_contract::ProjectId,
        binding: &ResourceBindingV1,
    ) -> Result<ResourceDescriptorV1> {
        binding.validate()?;
        let inner = self.inner();
        let current = inner
            .current
            .as_ref()
            .context("Resource Registry has no project context")?;
        ensure!(
            &current.project_id == project_id,
            "Resource binding belongs to another project"
        );
        let entry = inner
            .projects
            .get(project_id)
            .and_then(|project| project.entries.get(&binding.resource_id))
            .context("Bound Resource was not resolved")?;
        ensure!(
            entry.descriptor.resource_provider_id == binding.resource_provider_id
                && entry.descriptor.resource_kind == binding.resource_kind,
            "Bound Resource provider or kind is unavailable"
        );
        ensure!(
            entry.descriptor.status == ResourceStatusV1::Ready,
            "Bound Resource is unavailable"
        );
        ensure!(
            binding.resource_revision == Some(entry.descriptor.resource_revision),
            "Bound Resource revision is stale"
        );
        Ok(entry.descriptor.clone())
    }

    fn read_document(&self, target: &ResourceTargetV1) -> Result<ResourceContentV1> {
        let mut inner = self.inner();
        let entry = Self::target(&inner, target, false)?;
        let current = inner.current.clone().unwrap();
        if let Some(document) = inner
            .projects
            .get(&current.project_id)
            .and_then(|project| project.documents.get(&entry.descriptor.resource_id))
        {
            return content_from_document(&entry.descriptor, document);
        }
        ensure!(
            entry.descriptor.status == ResourceStatusV1::Ready,
            "Resource is unavailable"
        );
        ensure!(
            entry
                .descriptor
                .capabilities
                .iter()
                .any(|capability| capability.as_str() == "resource.read.document"),
            "Resource does not support a shared document"
        );
        let path = project_path(&current.root, &entry.descriptor.resource_id)?;
        let project = inner.projects.get_mut(&current.project_id).unwrap();
        if !project
            .documents
            .contains_key(&entry.descriptor.resource_id)
        {
            ensure!(
                project.documents.len() < rho_ui_contract::MAX_RESOURCE_DOCUMENTS,
                "Shared Resource document budget is exhausted"
            );
            ensure_editable_file_size(&path)?;
            let content = std::fs::read_to_string(&path).with_context(|| {
                format!(
                    "Resource is not valid UTF-8: {}",
                    entry.descriptor.resource_id
                )
            })?;
            project.documents.insert(
                entry.descriptor.resource_id.clone(),
                DocumentState {
                    content: content.clone(),
                    base_content: content,
                    document_revision: 1,
                    base_resource_revision: entry.descriptor.resource_revision,
                    dirty: false,
                },
            );
            Self::bump(&mut inner)?;
        }
        let project = inner.projects.get(&current.project_id).unwrap();
        let document = project
            .documents
            .get(&entry.descriptor.resource_id)
            .unwrap();
        content_from_document(&entry.descriptor, document)
    }

    fn update_draft(&self, request: &ResourceDraftRequestV1) -> Result<ResourceContentV1> {
        request.validate()?;
        let mut inner = self.inner();
        let entry = Self::target(&inner, &request.target, false)?;
        let current = inner.current.clone().unwrap();
        let project = inner.projects.get_mut(&current.project_id).unwrap();
        let document = project
            .documents
            .get_mut(&entry.descriptor.resource_id)
            .context("Shared Resource document is not open")?;
        ensure!(
            document.document_revision == request.expected_document_revision,
            "Resource document revision is stale"
        );
        document.content = request.content.clone();
        document.dirty = document.content != document.base_content;
        document.document_revision = next_revision(
            "resource_document.document_revision",
            document.document_revision,
        )?;
        let document = document.clone();
        Self::bump(&mut inner)?;
        content_from_document(&entry.descriptor, &document)
    }

    fn save_admission(
        &self,
        request: &ResourceSaveRequestV1,
    ) -> Result<(ProjectCursor, ResourceEntry, DocumentState)> {
        request.validate()?;
        let inner = self.inner();
        let entry = Self::target(&inner, &request.target, false)?;
        ensure!(
            supports(&entry, "resource.write"),
            "Resource is not writable"
        );
        let current = inner.current.clone().unwrap();
        let document = inner
            .projects
            .get(&current.project_id)
            .and_then(|project| project.documents.get(&entry.descriptor.resource_id))
            .context("Shared Resource document is not open")?
            .clone();
        ensure!(
            document.document_revision == request.expected_document_revision,
            "Resource document revision is stale"
        );
        ensure!(
            document.base_resource_revision == entry.descriptor.resource_revision,
            "Resource changed on disk; reload before saving"
        );
        Ok((current, entry, document))
    }

    fn complete_save(
        &self,
        resource_id: &str,
        project_revision: u64,
        signature: FileSignature,
        digest: String,
    ) -> Result<(ResourceTransition, ResourceContentV1)> {
        let mut inner = self.inner();
        let current = inner
            .current
            .clone()
            .context("Resource project disappeared")?;
        let project = inner.projects.get_mut(&current.project_id).unwrap();
        let entry = project
            .entries
            .get_mut(resource_id)
            .context("Resource disappeared")?;
        entry.descriptor.resource_revision = next_revision(
            "resource.resource_revision",
            entry.descriptor.resource_revision,
        )?;
        entry.descriptor.size_bytes = Some(signature.size_bytes);
        entry.descriptor.content_sha256 = Some(digest);
        entry.descriptor.status = ResourceStatusV1::Ready;
        entry.signature = Some(signature);
        let descriptor = entry.descriptor.clone();
        let document = project
            .documents
            .get_mut(resource_id)
            .context("Resource document disappeared")?;
        document.base_content = document.content.clone();
        document.base_resource_revision = descriptor.resource_revision;
        document.dirty = false;
        document.document_revision = next_revision(
            "resource_document.document_revision",
            document.document_revision,
        )?;
        let document = document.clone();
        inner.current.as_mut().unwrap().project_revision = project_revision;
        Self::bump(&mut inner)?;
        Ok((
            Self::transition(&inner, "resource_saved", true)?,
            content_from_document(&descriptor, &document)?,
        ))
    }

    fn reload_admission(
        &self,
        request: &ResourceReloadRequestV1,
    ) -> Result<(ProjectCursor, ResourceEntry)> {
        request.validate()?;
        let inner = self.inner();
        let entry = Self::target(&inner, &request.target, false)?;
        ensure!(
            entry.descriptor.status == ResourceStatusV1::Ready,
            "Resource is unavailable"
        );
        let current = inner.current.clone().unwrap();
        let document = inner
            .projects
            .get(&current.project_id)
            .and_then(|project| project.documents.get(&entry.descriptor.resource_id))
            .context("Shared Resource document is not open")?;
        ensure!(
            document.document_revision == request.expected_document_revision,
            "Resource document revision is stale"
        );
        ensure!(
            !document.dirty || request.discard_dirty,
            "Resource has an unsaved draft; explicit discard is required"
        );
        Ok((current, entry))
    }

    fn complete_reload(
        &self,
        resource_id: &str,
        content: String,
    ) -> Result<(ResourceTransition, ResourceContentV1)> {
        let mut inner = self.inner();
        let current = inner.current.clone().unwrap();
        let project = inner.projects.get_mut(&current.project_id).unwrap();
        let descriptor = project
            .entries
            .get(resource_id)
            .context("Resource disappeared")?
            .descriptor
            .clone();
        let document = project
            .documents
            .get_mut(resource_id)
            .context("Resource document disappeared")?;
        document.content = content.clone();
        document.base_content = content;
        document.base_resource_revision = descriptor.resource_revision;
        document.dirty = false;
        document.document_revision = next_revision(
            "resource_document.document_revision",
            document.document_revision,
        )?;
        let document = document.clone();
        Self::bump(&mut inner)?;
        Ok((
            Self::transition(&inner, "resource_reloaded", true)?,
            content_from_document(&descriptor, &document)?,
        ))
    }

    fn rename_admission(
        &self,
        request: &ResourceRenameRequestV1,
    ) -> Result<(ProjectCursor, ResourceEntry)> {
        request.validate()?;
        let inner = self.inner();
        let entry = Self::target(&inner, &request.target, true)?;
        ensure!(
            entry.descriptor.status == ResourceStatusV1::Ready,
            "Resource is unavailable"
        );
        ensure!(
            supports(&entry, "resource.rename"),
            "Resource cannot be renamed"
        );
        let current = inner.current.clone().unwrap();
        let document = inner
            .projects
            .get(&current.project_id)
            .and_then(|project| project.documents.get(&entry.descriptor.resource_id));
        match document {
            Some(document) => ensure!(
                request.expected_document_revision == Some(document.document_revision),
                "Resource document revision is stale"
            ),
            None => ensure!(
                request.expected_document_revision.is_none(),
                "Resource document is not open"
            ),
        }
        Ok((current, entry))
    }

    fn complete_rename(
        &self,
        old_resource_id: &str,
        new_resource_id: &str,
    ) -> Result<ResourceTransition> {
        let mut inner = self.inner();
        let current = inner
            .current
            .clone()
            .context("Resource project disappeared")?;
        let project = inner.projects.get_mut(&current.project_id).unwrap();
        let descriptor = project
            .entries
            .get(new_resource_id)
            .context("Renamed Resource was not reconciled")?
            .descriptor
            .clone();
        project.entries.remove(old_resource_id);
        if let Some(mut document) = project.documents.remove(old_resource_id) {
            document.base_resource_revision = descriptor.resource_revision;
            document.document_revision = next_revision(
                "resource_document.document_revision",
                document.document_revision,
            )?;
            project
                .documents
                .insert(new_resource_id.to_string(), document);
        }
        Self::bump(&mut inner)?;
        Self::transition(&inner, "resource_renamed", true)
    }

    fn complete_delete(
        &self,
        resource_id: &str,
        discard_document: bool,
    ) -> Result<ResourceTransition> {
        let mut inner = self.inner();
        let current = inner
            .current
            .clone()
            .context("Resource project disappeared")?;
        if discard_document {
            inner
                .projects
                .get_mut(&current.project_id)
                .unwrap()
                .documents
                .remove(resource_id);
        }
        Self::transition(&inner, "resource_deleted", true)
    }
}

fn content_from_document(
    descriptor: &ResourceDescriptorV1,
    document: &DocumentState,
) -> Result<ResourceContentV1> {
    let content = ResourceContentV1 {
        contract: RESOURCE_CONTENT_CONTRACT.to_string(),
        descriptor: descriptor.clone(),
        consistency: ResourceReadConsistencyV1::SharedDocument,
        document_revision: document.document_revision,
        base_resource_revision: document.base_resource_revision,
        dirty: document.dirty,
        stale: descriptor.status != ResourceStatusV1::Ready
            || descriptor.resource_revision != document.base_resource_revision,
        content_encoding: "utf-8".to_string(),
        content: document.content.clone(),
    };
    content.validate()?;
    Ok(content)
}

fn application_providers(state: &AppState) -> Result<Vec<ResourceProviderRegistrationV1>> {
    let application = state.extension_host.scopes().application();
    let resolution = application
        .registry()
        .resolve_application_resource_providers()?;
    Ok(resolution.providers().to_vec())
}

pub(crate) async fn reconcile_for_state(state: &AppState) -> Result<ResourceTransition> {
    let kernel = crate::ui_runtime::snapshot_for_state(state).await?;
    let root = state.project_root.read().await.clone();
    state.resource_registry.reconcile(
        kernel.project.project_id.clone(),
        kernel.context.project_revision,
        root,
        application_providers(state)?,
    )
}

pub(crate) fn emit_transition(app: &AppHandle, transition: &ResourceTransition) {
    if !transition.changed {
        return;
    }
    let snapshot = &transition.snapshot;
    let _ = app.emit(
        RESOURCE_REGISTRY_CHANGED_EVENT,
        ResourceRegistryChangedEvent {
            reason: transition.reason,
            snapshot_revision: snapshot.snapshot_revision,
            project_id: &snapshot.project_id,
            project_revision: snapshot.project_revision,
        },
    );
}

async fn prepare(app: &AppHandle, state: &AppState) -> Result<ResourceTransition> {
    let transition = reconcile_for_state(state).await?;
    emit_transition(app, &transition);
    Ok(transition)
}

async fn record_project_change(state: &AppState) -> Result<u64> {
    let context = crate::active_context(state).await?;
    let mut context = context.lock().await;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    context.store.save_identity(&identity)?;
    Ok(identity.project_revision)
}

fn mutation_recovery_error(operation: anyhow::Error, recovery: Result<()>) -> String {
    match recovery {
        Ok(()) => display_error(operation),
        Err(recovery) => format!(
            "{}; recovery also failed: {}",
            display_error(operation),
            display_error(recovery)
        ),
    }
}

#[tauri::command]
pub(crate) async fn resource_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceRegistrySnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    prepare(&app, &state)
        .await
        .map(|transition| transition.snapshot)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn resource_resolve(
    request: ResourceResolveRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceRegistrySnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let transition = state
        .resource_registry
        .resolve_path(&request)
        .map_err(display_error)?;
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

#[tauri::command]
pub(crate) async fn resource_read(
    request: ResourceReadRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceContentV1, String> {
    request.validate().map_err(display_error)?;
    let _project = state.project_transition_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    match request.consistency {
        ResourceReadConsistencyV1::SharedDocument => {
            let before = state.resource_registry.inner().snapshot_revision;
            let content = state
                .resource_registry
                .read_document(&request.target)
                .map_err(display_error)?;
            let after = state.resource_registry.inner().snapshot_revision;
            if after != before {
                let transition = {
                    let inner = state.resource_registry.inner();
                    ResourceRegistryState::transition(&inner, "resource_document_opened", true)
                        .map_err(display_error)?
                };
                emit_transition(&app, &transition);
            }
            Ok(content)
        }
        ResourceReadConsistencyV1::ImmutableSnapshot => {
            let entry = {
                let inner = state.resource_registry.inner();
                ResourceRegistryState::target(&inner, &request.target, true)
                    .map_err(display_error)?
            };
            if entry.descriptor.status != ResourceStatusV1::Ready {
                return Err("Resource is unavailable".to_string());
            }
            if !preview_supported(&entry.descriptor.resource_id) {
                return Err("Resource preview is unsupported".to_string());
            }
            let viewed =
                crate::viewer_read_file_with_state(entry.descriptor.resource_id.clone(), &state)
                    .await?;
            let content = ResourceContentV1 {
                contract: RESOURCE_CONTENT_CONTRACT.to_string(),
                descriptor: entry.descriptor.clone(),
                consistency: ResourceReadConsistencyV1::ImmutableSnapshot,
                document_revision: 1,
                base_resource_revision: entry.descriptor.resource_revision,
                dirty: false,
                stale: false,
                content_encoding: viewed.content_encoding.to_string(),
                content: viewed.content,
            };
            content.validate().map_err(display_error)?;
            Ok(content)
        }
    }
}

#[tauri::command]
pub(crate) async fn resource_update_draft(
    request: ResourceDraftRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceContentV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let content = state
        .resource_registry
        .update_draft(&request)
        .map_err(display_error)?;
    let transition = {
        let inner = state.resource_registry.inner();
        ResourceRegistryState::transition(&inner, "resource_draft_updated", true)
            .map_err(display_error)?
    };
    emit_transition(&app, &transition);
    Ok(content)
}

#[tauri::command]
pub(crate) async fn resource_save(
    request: ResourceSaveRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceContentV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let _operation = state.resource_registry.operation_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let (cursor, entry, document) = state
        .resource_registry
        .save_admission(&request)
        .map_err(display_error)?;
    ensure_editable_content_size(&document.content).map_err(display_error)?;
    let path = project_path(&cursor.root, &entry.descriptor.resource_id).map_err(display_error)?;
    if entry.signature.as_ref() != Some(&file_signature(&path).map_err(display_error)?) {
        return Err("Resource changed during save admission".to_string());
    }
    let previous_content = std::fs::read(&path).map_err(display_error)?;
    atomic_write(&path, document.content.as_bytes()).map_err(display_error)?;
    let signature = match file_signature(&path) {
        Ok(signature) => signature,
        Err(error) => {
            return Err(mutation_recovery_error(
                error,
                atomic_write(&path, &previous_content),
            ));
        }
    };
    let digest = content_sha256(document.content.as_bytes());
    let project_revision = match record_project_change(&state).await {
        Ok(revision) => revision,
        Err(error) => {
            return Err(mutation_recovery_error(
                error,
                atomic_write(&path, &previous_content),
            ));
        }
    };
    let completion = state.resource_registry.complete_save(
        &entry.descriptor.resource_id,
        project_revision,
        signature,
        digest,
    );
    let (transition, content) = match completion {
        Ok(completion) => completion,
        Err(error) => {
            let recovery = atomic_write(&path, &previous_content).and_then(|()| {
                state.resource_registry.reconcile(
                    cursor.project_id,
                    project_revision,
                    cursor.root,
                    application_providers(&state)?,
                )?;
                Ok(())
            });
            return Err(mutation_recovery_error(error, recovery));
        }
    };
    emit_transition(&app, &transition);
    crate::surface_runtime::rebind_shared_resource(&app, &state, &content.descriptor)
        .map_err(display_error)?;
    Ok(content)
}

#[tauri::command]
pub(crate) async fn resource_reload(
    request: ResourceReloadRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceContentV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let _operation = state.resource_registry.operation_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let (cursor, entry) = state
        .resource_registry
        .reload_admission(&request)
        .map_err(display_error)?;
    let path = project_path(&cursor.root, &entry.descriptor.resource_id).map_err(display_error)?;
    ensure_editable_file_size(&path).map_err(display_error)?;
    let content = std::fs::read_to_string(&path).map_err(display_error)?;
    let (transition, content) = state
        .resource_registry
        .complete_reload(&entry.descriptor.resource_id, content)
        .map_err(display_error)?;
    emit_transition(&app, &transition);
    crate::surface_runtime::rebind_shared_resource(&app, &state, &content.descriptor)
        .map_err(display_error)?;
    Ok(content)
}

#[tauri::command]
pub(crate) async fn resource_rename(
    request: ResourceRenameRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceRegistrySnapshotV1, String> {
    request.validate().map_err(display_error)?;
    let _project = state.project_transition_gate.lock().await;
    let _operation = state.resource_registry.operation_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let (cursor, entry) = state
        .resource_registry
        .rename_admission(&request)
        .map_err(display_error)?;
    let old_id = entry.descriptor.resource_id.clone();
    let new_id = normalized_resource_id(&request.new_resource_id).map_err(display_error)?;
    let root = cursor.root;
    let old_path = project_path(&root, &old_id).map_err(display_error)?;
    let new_path = project_path(&root, &new_id).map_err(display_error)?;
    let providers = application_providers(&state).map_err(display_error)?;
    if new_path.exists() {
        return Err("Rename target already exists".to_string());
    }
    ensure_editable_file(&new_path).map_err(display_error)?;
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent).map_err(display_error)?;
    }
    std::fs::rename(&old_path, &new_path).map_err(display_error)?;
    let project_revision = match record_project_change(&state).await {
        Ok(revision) => revision,
        Err(error) => {
            return Err(mutation_recovery_error(
                error,
                std::fs::rename(&new_path, &old_path).map_err(anyhow::Error::from),
            ));
        }
    };
    let completion = state
        .resource_registry
        .reconcile(
            request.target.project_id.clone(),
            project_revision,
            root.clone(),
            providers.clone(),
        )
        .and_then(|_| state.resource_registry.complete_rename(&old_id, &new_id));
    let transition = match completion {
        Ok(transition) => transition,
        Err(error) => {
            let recovery = std::fs::rename(&new_path, &old_path)
                .map_err(anyhow::Error::from)
                .and_then(|()| {
                    state.resource_registry.reconcile(
                        request.target.project_id.clone(),
                        project_revision,
                        root,
                        providers,
                    )?;
                    Ok(())
                });
            return Err(mutation_recovery_error(error, recovery));
        }
    };
    emit_transition(&app, &transition);
    crate::surface_runtime::rename_resource_bindings(
        &app,
        &state,
        &old_id,
        &new_id,
        &transition.snapshot,
    )
    .map_err(display_error)?;
    Ok(transition.snapshot)
}

#[tauri::command]
pub(crate) async fn resource_delete(
    request: ResourceDeleteRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResourceRegistrySnapshotV1, String> {
    request.validate().map_err(display_error)?;
    let _project = state.project_transition_gate.lock().await;
    let _operation = state.resource_registry.operation_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let entry = {
        let inner = state.resource_registry.inner();
        let entry =
            ResourceRegistryState::target(&inner, &request.target, true).map_err(display_error)?;
        if entry.descriptor.status != ResourceStatusV1::Ready {
            return Err("Resource is unavailable".to_string());
        }
        if !supports(&entry, "resource.delete") {
            return Err("Resource cannot be deleted".to_string());
        }
        if let Some(document) = inner
            .projects
            .get(&request.target.project_id)
            .and_then(|project| project.documents.get(&entry.descriptor.resource_id))
        {
            if request.expected_document_revision != Some(document.document_revision) {
                return Err("Resource document revision is stale".to_string());
            }
            if document.dirty && !request.discard_dirty {
                return Err(
                    "Resource has an unsaved draft; explicit discard is required".to_string(),
                );
            }
        }
        entry
    };
    let root = state.project_root.read().await.clone();
    let path = project_path(&root, &entry.descriptor.resource_id).map_err(display_error)?;
    let providers = application_providers(&state).map_err(display_error)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Resource path has no parent".to_string())?;
    let quarantine = parent.join(format!(".rho-delete-{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::rename(&path, &quarantine).map_err(display_error)?;
    let project_revision = match record_project_change(&state).await {
        Ok(revision) => revision,
        Err(error) => {
            return Err(mutation_recovery_error(
                error,
                std::fs::rename(&quarantine, &path).map_err(anyhow::Error::from),
            ));
        }
    };
    let completion = state
        .resource_registry
        .reconcile(
            request.target.project_id.clone(),
            project_revision,
            root.clone(),
            providers.clone(),
        )
        .and_then(|_| {
            state
                .resource_registry
                .complete_delete(&entry.descriptor.resource_id, request.discard_dirty)
        });
    let transition = match completion {
        Ok(transition) => transition,
        Err(error) => {
            let recovery = std::fs::rename(&quarantine, &path)
                .map_err(anyhow::Error::from)
                .and_then(|()| {
                    state.resource_registry.reconcile(
                        request.target.project_id.clone(),
                        project_revision,
                        root,
                        providers,
                    )?;
                    Ok(())
                });
            return Err(mutation_recovery_error(error, recovery));
        }
    };
    if let Err(error) = std::fs::remove_file(&quarantine) {
        let recovery = std::fs::rename(&quarantine, &path)
            .map_err(anyhow::Error::from)
            .and_then(|()| {
                state.resource_registry.reconcile(
                    request.target.project_id.clone(),
                    project_revision,
                    root,
                    providers,
                )?;
                Ok(())
            });
        return Err(mutation_recovery_error(anyhow::Error::new(error), recovery));
    }
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_ui_contract::{ApplicationComponentId, ProjectId, ResourceProviderDefinitionV1};

    fn provider() -> ResourceProviderRegistrationV1 {
        ResourceProviderRegistrationV1 {
            definition: ResourceProviderDefinitionV1 {
                resource_provider_id: ResourceProviderId::new(PROJECT_FILE_PROVIDER).unwrap(),
                resource_kinds: vec![ResourceKindId::new(PROJECT_FILE_KIND).unwrap()],
                display_label: "Project files".to_string(),
                capabilities: capabilities("analysis.R", true),
                application_component_id: ApplicationComponentId::new("rho.resource.project-files")
                    .unwrap(),
            },
            activation_generation: 1,
        }
    }

    fn setup_file(
        content: &str,
    ) -> (
        tempfile::TempDir,
        PathBuf,
        ResourceRegistryState,
        ResourceTargetV1,
    ) {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("analysis.R"), content).unwrap();
        let root = temp.path().canonicalize().unwrap();
        let registry = ResourceRegistryState::default();
        let project = ProjectId::new("project:test").unwrap();
        let snapshot = registry
            .reconcile(project.clone(), 1, root.clone(), vec![provider()])
            .unwrap()
            .snapshot;
        let descriptor = snapshot.resources[0].clone();
        let target = ResourceTargetV1 {
            project_id: project,
            resource_provider_id: descriptor.resource_provider_id,
            resource_kind: descriptor.resource_kind,
            resource_id: descriptor.resource_id,
            expected_project_revision: 1,
            expected_resource_revision: descriptor.resource_revision,
        };
        (temp, root, registry, target)
    }

    #[test]
    fn normalized_resource_ids_reject_aliases_and_escape() {
        assert_eq!(
            normalized_resource_id("R/analysis.R").unwrap(),
            "R/analysis.R"
        );
        for invalid in [
            "/analysis.R",
            "../analysis.R",
            "R//analysis.R",
            "R/./analysis.R",
        ] {
            assert!(normalized_resource_id(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn reconcile_preserves_dirty_document_across_project_a_b_a_and_marks_external_stale() {
        let temp = tempfile::tempdir().unwrap();
        let root_a = temp.path().join("A");
        let root_b = temp.path().join("B");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        std::fs::write(root_a.join("analysis.R"), "value <- 1\n").unwrap();
        std::fs::write(root_b.join("analysis.R"), "value <- 2\n").unwrap();
        let root_a = root_a.canonicalize().unwrap();
        let root_b = root_b.canonicalize().unwrap();
        let registry = ResourceRegistryState::default();
        let project_a = ProjectId::new("project:a").unwrap();
        let a = registry
            .reconcile(project_a.clone(), 1, root_a.clone(), vec![provider()])
            .unwrap();
        let descriptor = a.snapshot.resources[0].clone();
        let target = ResourceTargetV1 {
            project_id: project_a.clone(),
            resource_provider_id: descriptor.resource_provider_id.clone(),
            resource_kind: descriptor.resource_kind.clone(),
            resource_id: descriptor.resource_id.clone(),
            expected_project_revision: 1,
            expected_resource_revision: descriptor.resource_revision,
        };
        let opened = registry.read_document(&target).unwrap();
        let draft = registry
            .update_draft(&ResourceDraftRequestV1 {
                target: target.clone(),
                expected_document_revision: opened.document_revision,
                content: "draft <- TRUE\n".to_string(),
            })
            .unwrap();
        registry
            .reconcile(
                ProjectId::new("project:b").unwrap(),
                1,
                root_b,
                vec![provider()],
            )
            .unwrap();
        std::fs::write(root_a.join("analysis.R"), "external <- TRUE\n").unwrap();
        registry
            .reconcile(project_a, 2, root_a, vec![provider()])
            .unwrap();
        let restored = registry
            .read_document(&ResourceTargetV1 {
                expected_project_revision: 2,
                ..target
            })
            .unwrap();
        assert_eq!(restored.content, draft.content);
        assert!(restored.dirty);
        assert!(restored.stale);
    }

    #[test]
    fn stale_draft_mutation_is_transactional() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("analysis.R"), "value <- 1\n").unwrap();
        let root = temp.path().canonicalize().unwrap();
        let registry = ResourceRegistryState::default();
        let project = ProjectId::new("project:a").unwrap();
        let snapshot = registry
            .reconcile(project.clone(), 1, root, vec![provider()])
            .unwrap()
            .snapshot;
        let descriptor = snapshot.resources[0].clone();
        let target = ResourceTargetV1 {
            project_id: project,
            resource_provider_id: descriptor.resource_provider_id.clone(),
            resource_kind: descriptor.resource_kind.clone(),
            resource_id: descriptor.resource_id.clone(),
            expected_project_revision: 1,
            expected_resource_revision: descriptor.resource_revision,
        };
        let opened = registry.read_document(&target).unwrap();
        let mut stale = ResourceDraftRequestV1 {
            target,
            expected_document_revision: opened.document_revision + 1,
            content: "stale".to_string(),
        };
        assert!(registry.update_draft(&stale).is_err());
        stale.expected_document_revision = opened.document_revision;
        assert_eq!(registry.update_draft(&stale).unwrap().content, "stale");
    }

    #[test]
    fn explicit_resolution_distinguishes_ready_unsupported_and_missing() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("plot.png"), b"png").unwrap();
        std::fs::write(temp.path().join("archive.bin"), b"binary").unwrap();
        let root = temp.path().canonicalize().unwrap();
        let registry = ResourceRegistryState::default();
        let project = ProjectId::new("project:resolve").unwrap();
        let mut snapshot = registry
            .reconcile(project.clone(), 1, root.clone(), vec![provider()])
            .unwrap()
            .snapshot;
        for (path, expected) in [
            ("plot.png", ResourceStatusV1::Ready),
            ("archive.bin", ResourceStatusV1::Unsupported),
            ("absent.R", ResourceStatusV1::Missing),
        ] {
            snapshot = registry
                .resolve_path(&ResourceResolveRequestV1 {
                    project_id: project.clone(),
                    resource_provider_id: ResourceProviderId::new(PROJECT_FILE_PROVIDER).unwrap(),
                    resource_kind: ResourceKindId::new(PROJECT_FILE_KIND).unwrap(),
                    resource_id: path.to_string(),
                    expected_project_revision: 1,
                    expected_snapshot_revision: snapshot.snapshot_revision,
                })
                .unwrap()
                .snapshot;
            assert_eq!(
                snapshot
                    .resources
                    .iter()
                    .find(|resource| resource.resource_id == path)
                    .unwrap()
                    .status,
                expected
            );
        }
        let reconciled = registry
            .reconcile(project, 2, root, vec![provider()])
            .unwrap()
            .snapshot;
        assert_eq!(
            reconciled
                .resources
                .iter()
                .find(|resource| resource.resource_id == "plot.png")
                .unwrap()
                .status,
            ResourceStatusV1::Ready
        );
    }

    #[test]
    fn deleted_file_keeps_dirty_shared_document_as_stale_recovery_content() {
        let (_temp, root, registry, target) = setup_file("value <- 1\n");
        let opened = registry.read_document(&target).unwrap();
        let draft = registry
            .update_draft(&ResourceDraftRequestV1 {
                target: target.clone(),
                expected_document_revision: opened.document_revision,
                content: "recovery <- TRUE\n".to_string(),
            })
            .unwrap();
        std::fs::remove_file(root.join("analysis.R")).unwrap();
        registry
            .reconcile(target.project_id.clone(), 2, root, vec![provider()])
            .unwrap();
        let recovered = registry
            .read_document(&ResourceTargetV1 {
                expected_project_revision: 2,
                ..target
            })
            .unwrap();
        assert_eq!(recovered.content, draft.content);
        assert!(recovered.dirty);
        assert!(recovered.stale);
        assert_eq!(recovered.descriptor.status, ResourceStatusV1::Missing);
    }

    #[test]
    fn dirty_reload_and_external_save_conflict_require_explicit_recovery() {
        let (_temp, root, registry, target) = setup_file("value <- 1\n");
        let opened = registry.read_document(&target).unwrap();
        let draft = registry
            .update_draft(&ResourceDraftRequestV1 {
                target: target.clone(),
                expected_document_revision: opened.document_revision,
                content: "draft <- TRUE\n".to_string(),
            })
            .unwrap();
        let reload = ResourceReloadRequestV1 {
            target: target.clone(),
            expected_document_revision: draft.document_revision,
            discard_dirty: false,
        };
        assert!(registry.reload_admission(&reload).is_err());
        let (cursor, _) = registry
            .reload_admission(&ResourceReloadRequestV1 {
                discard_dirty: true,
                ..reload
            })
            .unwrap();
        assert_eq!(cursor.root, root);

        std::fs::write(root.join("analysis.R"), "external <- TRUE\n").unwrap();
        registry
            .reconcile(target.project_id.clone(), 2, root, vec![provider()])
            .unwrap();
        assert!(
            registry
                .save_admission(&ResourceSaveRequestV1 {
                    target: ResourceTargetV1 {
                        expected_project_revision: 2,
                        ..target
                    },
                    expected_document_revision: draft.document_revision,
                })
                .is_err()
        );
    }

    #[test]
    fn rename_moves_dirty_document_identity_without_coupling_view_modes() {
        let (_temp, root, registry, target) = setup_file("value <- 1\n");
        let opened = registry.read_document(&target).unwrap();
        let draft = registry
            .update_draft(&ResourceDraftRequestV1 {
                target: target.clone(),
                expected_document_revision: opened.document_revision,
                content: "draft <- TRUE\n".to_string(),
            })
            .unwrap();
        registry
            .rename_admission(&ResourceRenameRequestV1 {
                target: target.clone(),
                expected_document_revision: Some(draft.document_revision),
                new_resource_id: "R/renamed.R".to_string(),
            })
            .unwrap();
        std::fs::create_dir(root.join("R")).unwrap();
        std::fs::rename(root.join("analysis.R"), root.join("R/renamed.R")).unwrap();
        let snapshot = registry
            .reconcile(target.project_id.clone(), 2, root, vec![provider()])
            .unwrap()
            .snapshot;
        registry
            .complete_rename("analysis.R", "R/renamed.R")
            .unwrap();
        let descriptor = snapshot
            .resources
            .iter()
            .find(|resource| resource.resource_id == "R/renamed.R")
            .unwrap();
        let renamed = registry
            .read_document(&ResourceTargetV1 {
                project_id: target.project_id,
                resource_provider_id: descriptor.resource_provider_id.clone(),
                resource_kind: descriptor.resource_kind.clone(),
                resource_id: descriptor.resource_id.clone(),
                expected_project_revision: 2,
                expected_resource_revision: descriptor.resource_revision,
            })
            .unwrap();
        assert_eq!(renamed.content, "draft <- TRUE\n");
        assert!(renamed.dirty);
        assert!(!renamed.stale);
        assert!(
            registry
                .inner()
                .projects
                .get(&ProjectId::new("project:test").unwrap())
                .unwrap()
                .documents
                .get("analysis.R")
                .is_none()
        );
    }
}
