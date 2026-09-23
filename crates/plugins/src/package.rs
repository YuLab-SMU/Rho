use crate::{PluginError, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
};

pub const MAX_ARCHIVE_BYTES: u64 = MAX_PACKAGE_BYTES * 4 / 3 + 16 * 1024 * 1024;

pub fn content_digest(bytes: &[u8]) -> ContentDigest {
    ContentDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).expect("SHA256 encoding")
}

pub(crate) fn document_digest(value: &impl Serialize) -> Result<String, PluginError> {
    let mut value = serde_json::to_value(value)?;
    value.sort_all_objects();
    Ok(content_digest(&serde_json::to_vec(&value)?).to_string())
}

pub fn revision_digest(revision: &PluginRevision) -> Result<RevisionId, PluginError> {
    Ok(RevisionId::new(document_digest(&json!({
        "type": "rho.plugin.revision.v1", "parent": revision.parent,
        "manifest": revision.manifest, "files": revision.files,
    }))?)?)
}

pub fn artifact_digest(artifact: &BuildArtifact) -> Result<ArtifactId, PluginError> {
    Ok(ArtifactId::new(document_digest(&json!({
        "type": "rho.plugin.artifact.v1", "revision": artifact.revision,
        "target": artifact.target, "files": artifact.files,
    }))?)?)
}

/// Snapshot declared first-party source and dist/ bytes. No build or code load.
pub fn snapshot_directory(
    directory: &Path,
    parent: Option<RevisionId>,
    target: &str,
) -> Result<PluginArchive, PluginError> {
    let directory = directory.canonicalize()?;
    ensure(directory.is_dir(), "development source must be a directory")?;
    let manifest_path = PackagePath::new("plugin.json")?;
    let manifest_bytes = read_contained(&directory, &manifest_path, MAX_MANIFEST_BYTES as u64)?;
    let manifest: PluginManifest = serde_json::from_slice(&manifest_bytes)?;
    manifest.validate()?;
    validate_schemas(&manifest)?;
    let paths: BTreeSet<_> = manifest
        .source
        .files
        .iter()
        .chain(&manifest.source.lockfiles)
        .chain([&manifest.source.build_instructions, &manifest_path])
        .cloned()
        .collect();
    let mut blobs = BTreeMap::new();
    let mut files = BTreeMap::new();
    let mut total = 0;
    for path in paths {
        let bytes = read_contained(&directory, &path, MAX_PACKAGE_BYTES - total)?;
        total += bytes.len() as u64;
        let digest = content_digest(&bytes);
        files.insert(
            path.clone(),
            PackageFile {
                digest: digest.clone(),
                bytes: bytes.len() as u64,
                executable: is_executable(&directory.join(path.as_str()))?,
            },
        );
        blobs.insert(digest, STANDARD.encode(&bytes));
    }
    let mut revision = PluginRevision {
        id: RevisionId::new(format!("sha256:{}", "0".repeat(64)))?,
        parent,
        manifest,
        files,
    };
    revision.id = revision_digest(&revision)?;
    let mut artifact_files = BTreeMap::new();
    if directory.join("dist").symlink_metadata().is_ok() {
        collect_artifacts(
            &directory,
            Path::new("dist"),
            &mut artifact_files,
            &mut blobs,
            &mut total,
        )?;
    }
    let artifacts = if artifact_files.is_empty() {
        vec![]
    } else {
        let mut artifact = BuildArtifact {
            id: ArtifactId::new(format!("sha256:{}", "0".repeat(64)))?,
            revision: revision.id.clone(),
            target: target.into(),
            files: artifact_files,
        };
        artifact.id = artifact_digest(&artifact)?;
        vec![artifact]
    };
    let archive = PluginArchive {
        format_version: 1,
        revision,
        artifacts,
        blobs,
    };
    validate_archive(&archive)?;
    Ok(archive)
}

fn collect_artifacts(
    root: &Path,
    relative: &Path,
    files: &mut BTreeMap<PackagePath, PackageFile>,
    blobs: &mut BTreeMap<ContentDigest, String>,
    total: &mut u64,
) -> Result<(), PluginError> {
    let metadata = root.join(relative).symlink_metadata()?;
    ensure(
        !metadata.file_type().is_symlink(),
        "package symlinks are not supported",
    )?;
    if metadata.is_dir() {
        let mut children = fs::read_dir(root.join(relative))?.collect::<Result<Vec<_>, _>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            collect_artifacts(root, &relative.join(child.file_name()), files, blobs, total)?;
        }
    } else {
        ensure(metadata.is_file(), "package contains a special file")?;
        ensure(files.len() < MAX_PACKAGE_FILES, "too many artifact files")?;
        let path = PackagePath::new(
            relative
                .to_str()
                .ok_or_else(|| PluginError::Invalid("package path is not UTF-8".into()))?,
        )?;
        let bytes = read_contained(root, &path, MAX_PACKAGE_BYTES - *total)?;
        *total += bytes.len() as u64;
        let digest = content_digest(&bytes);
        files.insert(
            path,
            PackageFile {
                digest: digest.clone(),
                bytes: bytes.len() as u64,
                executable: is_executable(&root.join(relative))?,
            },
        );
        blobs.insert(digest, STANDARD.encode(&bytes));
    }
    Ok(())
}

fn is_executable(path: &Path) -> Result<bool, PluginError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(fs::metadata(path)?.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(false)
    }
}

fn read_contained(root: &Path, relative: &PackagePath, limit: u64) -> Result<Vec<u8>, PluginError> {
    let mut path = root.to_path_buf();
    for part in relative.as_str().split('/') {
        path.push(part);
        ensure(
            !path.symlink_metadata()?.file_type().is_symlink(),
            "package source contains a symlink",
        )?;
    }
    let file = fs::File::open(&path)?;
    let metadata = file.metadata()?;
    ensure(
        metadata.is_file() && metadata.len() <= limit,
        "package file is not regular or exceeds byte limit",
    )?;
    ensure(
        path.canonicalize()?.starts_with(root),
        "package path escaped its source root",
    )?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure(bytes.len() as u64 <= limit, "package bytes exceed limit")?;
    Ok(bytes)
}

pub fn read_archive(path: &Path) -> Result<PluginArchive, PluginError> {
    let file = fs::File::open(path)?;
    ensure(
        file.metadata()?.len() <= MAX_ARCHIVE_BYTES,
        "archive exceeds byte limit",
    )?;
    let mut bytes = Vec::new();
    file.take(MAX_ARCHIVE_BYTES + 1).read_to_end(&mut bytes)?;
    ensure(
        bytes.len() as u64 <= MAX_ARCHIVE_BYTES,
        "archive exceeds byte limit",
    )?;
    let archive: PluginArchive = serde_json::from_slice(&bytes)?;
    validate_archive(&archive)?;
    Ok(archive)
}

pub fn validate_archive(archive: &PluginArchive) -> Result<(), PluginError> {
    ensure(archive.format_version == 1, "unsupported archive format")?;
    let revision = &archive.revision;
    revision.manifest.validate()?;
    validate_schemas(&revision.manifest)?;
    ensure(
        revision_digest(revision)? == revision.id,
        "source revision digest mismatch",
    )?;
    ensure(
        revision.parent.as_ref() != Some(&revision.id),
        "revision cannot be its own parent",
    )?;
    ensure(
        archive.artifacts.len() <= 32 && archive.blobs.len() <= MAX_PACKAGE_FILES,
        "archive inventory exceeds limit",
    )?;
    let mut all_files = vec![];
    let mut total = 0u64;
    let mut needed = BTreeSet::new();
    check_paths(&revision.files)?;
    for path in revision.files.keys() {
        ensure(!path.is_artifact(), "artifact in source revision")?;
    }
    for path in revision
        .manifest
        .source
        .files
        .iter()
        .chain(&revision.manifest.source.lockfiles)
        .chain([&revision.manifest.source.build_instructions])
    {
        ensure(
            revision.files.contains_key(path),
            format!("declared source is absent: {path}"),
        )?;
    }
    all_files.extend(revision.files.values());
    let mut artifact_ids = BTreeSet::new();
    for artifact in &archive.artifacts {
        ensure(
            artifact.revision == revision.id && artifact_digest(artifact)? == artifact.id,
            "artifact identity mismatch",
        )?;
        ensure(artifact_ids.insert(&artifact.id), "duplicate artifact")?;
        ensure(
            !artifact.target.is_empty()
                && artifact.target.len() <= 128
                && artifact
                    .target
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)),
            "invalid artifact target",
        )?;
        ensure(!artifact.files.is_empty(), "empty build artifact")?;
        check_paths(&artifact.files)?;
        for path in artifact.files.keys() {
            ensure(path.is_artifact(), "artifact path outside dist/")?;
        }
        for view in &revision.manifest.views {
            ensure(
                artifact.files.contains_key(&view.entrypoint),
                "view entrypoint missing from artifact",
            )?;
        }
        if let Some(backend) = &revision.manifest.backend {
            ensure(
                artifact
                    .files
                    .get(&backend.executable)
                    .is_some_and(|f| f.executable),
                "backend entrypoint missing or not executable",
            )?;
        }
        all_files.extend(artifact.files.values());
    }
    ensure(
        all_files.len() <= MAX_PACKAGE_FILES,
        "too many package files",
    )?;
    for file in all_files {
        total = total
            .checked_add(file.bytes)
            .ok_or_else(|| PluginError::Invalid("package size overflow".into()))?;
        ensure(total <= MAX_PACKAGE_BYTES, "package exceeds byte limit")?;
        let encoded = archive
            .blobs
            .get(&file.digest)
            .ok_or_else(|| PluginError::Invalid("missing content blob".into()))?;
        ensure(
            encoded.len() as u64 <= file.bytes.div_ceil(3) * 4,
            "blob exceeds declared size",
        )?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| PluginError::Invalid("invalid base64 blob".into()))?;
        ensure(
            bytes.len() as u64 == file.bytes && content_digest(&bytes) == file.digest,
            "content blob digest/length mismatch",
        )?;
        needed.insert(&file.digest);
    }
    ensure(
        needed.len() == archive.blobs.len(),
        "archive contains undeclared content blobs",
    )?;
    let manifest_file = revision
        .files
        .get(&PackagePath::new("plugin.json")?)
        .ok_or_else(|| PluginError::Invalid("plugin.json is missing".into()))?;
    let manifest_bytes = STANDARD
        .decode(&archive.blobs[&manifest_file.digest])
        .map_err(|_| PluginError::Invalid("invalid manifest encoding".into()))?;
    ensure(
        serde_json::from_slice::<PluginManifest>(&manifest_bytes)? == revision.manifest,
        "plugin.json disagrees with revision manifest",
    )?;
    for (path, file) in &revision.files {
        if path.as_str().starts_with("views/") && path.as_str().ends_with(".json") {
            let bytes = STANDARD
                .decode(&archive.blobs[&file.digest])
                .map_err(|_| PluginError::Invalid("invalid visual document encoding".into()))?;
            serde_json::from_slice::<VisualDocument>(&bytes)?.validate()?;
        }
    }
    Ok(())
}

fn check_paths(files: &BTreeMap<PackagePath, PackageFile>) -> Result<(), PluginError> {
    let mut folded = BTreeSet::new();
    for path in files.keys() {
        ensure(
            folded.insert(path.as_str().to_lowercase()),
            "case-colliding package paths",
        )?;
    }
    for path in &folded {
        for (index, _) in path.match_indices('/') {
            ensure(
                !folded.contains(&path[..index]),
                "package path is both a file and directory",
            )?;
        }
    }
    Ok(())
}

fn validate_schemas(manifest: &PluginManifest) -> Result<(), PluginError> {
    // jsonschema is built without HTTP/file resolution; refs are package-local schemas.
    let mut schemas = vec![&manifest.configuration_schema];
    for view in &manifest.views {
        schemas.extend([&view.configuration_schema, &view.state_schema]);
    }
    for cap in &manifest.capabilities {
        schemas.extend([&cap.input_schema, &cap.output_schema, &cap.recovery_schema]);
    }
    for schema in schemas {
        reject_external_refs(schema)?;
        jsonschema::validator_for(schema)
            .map_err(|e| PluginError::Invalid(format!("invalid contribution schema: {e}")))?;
    }
    for cap in &manifest.capabilities {
        for example in &cap.examples {
            crate::runtime::validate_value(&cap.input_schema, example, "discovery example")?;
        }
    }
    let validator = jsonschema::validator_for(&manifest.configuration_schema)
        .map_err(|e| PluginError::Invalid(e.to_string()))?;
    ensure(
        validator.is_valid(&manifest.default_configuration),
        "default configuration fails its schema",
    )
}

fn reject_external_refs(value: &serde_json::Value) -> Result<(), PluginError> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                if matches!(key.as_str(), "$ref" | "$dynamicRef" | "$recursiveRef") {
                    ensure(
                        value.as_str().is_some_and(|s| s.starts_with('#')),
                        "external schema references are not allowed",
                    )?;
                }
                reject_external_refs(value)?;
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                reject_external_refs(value)?;
            }
        }
        _ => (),
    }
    Ok(())
}
