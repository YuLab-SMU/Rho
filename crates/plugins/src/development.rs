use crate::{
    PluginError, PluginRepository, content_digest, ensure, repository::store_archive,
    revision_digest, validate_archive,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
};

impl PluginRepository {
    pub fn source_page(&self, args: &ListPluginSource) -> Result<PluginSourcePage, PluginError> {
        ensure(
            (1..=100).contains(&args.limit),
            "source page size must be 1–100",
        )?;
        let revision = self.revision(&args.revision)?;
        let mut entries = revision
            .files
            .iter()
            .filter(|(path, _)| args.after.as_ref().is_none_or(|after| *path > after));
        let files: BTreeMap<_, _> = entries
            .by_ref()
            .take(args.limit as usize)
            .map(|(path, file)| (path.clone(), file.clone()))
            .collect();
        let next = entries
            .next()
            .and_then(|_| files.last_key_value().map(|(path, _)| path.clone()));
        Ok(PluginSourcePage {
            revision: revision.id,
            total: revision.files.len() as u64,
            files,
            next,
        })
    }

    pub fn read_source(&self, args: &ReadPluginSource) -> Result<PluginSourceChunk, PluginError> {
        ensure(
            (1..=MAX_SOURCE_CHUNK_BYTES).contains(&args.limit),
            "source read size must be 1–65536 bytes",
        )?;
        let transaction = self.connection.unchecked_transaction()?;
        let revision = self.revision(&args.revision)?;
        let file = source_file(&revision, &args.path)?.clone();
        ensure(
            args.offset <= file.bytes,
            "source offset exceeds file length",
        )?;
        let end = file
            .bytes
            .min(args.offset.saturating_add(u64::from(args.limit)));
        let bytes = self.verified_source_bytes(&file, args.offset..end)?;
        transaction.commit()?;
        Ok(PluginSourceChunk {
            revision: revision.id,
            path: args.path.clone(),
            file: file.clone(),
            offset: args.offset,
            content_base64: STANDARD.encode(bytes),
            next_offset: (end < file.bytes).then_some(end),
        })
    }

    // Stream the full immutable digest in bounded slices. In particular, corruption outside
    // the requested slice cannot be disguised as a successful partial source observation.
    fn verified_source_bytes(
        &self,
        file: &PackageFile,
        keep: Range<u64>,
    ) -> Result<Vec<u8>, PluginError> {
        ensure(
            file.bytes <= MAX_PACKAGE_BYTES && keep.start <= keep.end && keep.end <= file.bytes,
            "source file exceeds package quota",
        )?;
        let length: u64 = self
            .connection
            .query_row(
                "SELECT length(bytes) FROM blobs WHERE digest=?",
                [file.digest.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| PluginError::Missing(file.digest.to_string()))?;
        ensure(length == file.bytes, "stored source length mismatch")?;
        let mut query = self
            .connection
            .prepare("SELECT substr(bytes,?2,?3) FROM blobs WHERE digest=?1")?;
        let mut hash = Sha256::new();
        let mut kept = Vec::with_capacity((keep.end - keep.start) as usize);
        let mut offset = 0;
        while offset < length {
            let size = (length - offset).min(u64::from(MAX_SOURCE_CHUNK_BYTES));
            let bytes: Vec<u8> = query
                .query_row(params![file.digest.as_str(), offset + 1, size], |row| {
                    row.get(0)
                })?;
            ensure(
                bytes.len() as u64 == size,
                "stored source slice is incomplete",
            )?;
            hash.update(&bytes);
            let from = offset.max(keep.start);
            let to = (offset + size).min(keep.end);
            if from < to {
                kept.extend_from_slice(&bytes[(from - offset) as usize..(to - offset) as usize]);
            }
            offset += size;
        }
        ensure(
            format!("sha256:{:x}", hash.finalize()) == file.digest.as_str(),
            "stored source digest mismatch",
        )?;
        Ok(kept)
    }

    pub fn branches(&self, args: &ListPluginBranches) -> Result<PluginBranchPage, PluginError> {
        ensure(
            (1..=100).contains(&args.limit),
            "branch page size must be 1–100",
        )?;
        let transaction = self.connection.unchecked_transaction()?;
        // Opening the owner records new branch origins. Read-only observation never adds
        // metadata to catalogs created before this observation capability existed.
        let has_origins: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_branch_origins')", [], |row| row.get(0))?;
        let (origin, join) = if has_origins {
            (
                "o.revision",
                "LEFT JOIN plugin_branch_origins o ON o.branch=b.id",
            )
        } else {
            ("NULL", "")
        };
        let sql = format!(
            "SELECT b.id,b.name,b.head,{origin} FROM branches b {join} WHERE b.plugin=?1 AND (?2 IS NULL OR b.id>?2) ORDER BY b.id LIMIT ?3"
        );
        let rows = transaction
            .prepare(&sql)?
            .query_map(
                params![
                    args.plugin.as_str(),
                    args.after.as_ref().map(BranchId::as_str),
                    args.limit + 1
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = rows.len() > args.limit as usize;
        let branches: Vec<PluginBranch> = rows
            .into_iter()
            .take(args.limit as usize)
            .map(|(id, name, head, origin)| {
                Ok(PluginBranch {
                    id: BranchId::new(id)?,
                    plugin: args.plugin.clone(),
                    name,
                    head: RevisionId::new(head)?,
                    origin: origin.map(RevisionId::new).transpose()?,
                })
            })
            .collect::<Result<_, PluginError>>()?;
        transaction.commit()?;
        let next = has_more.then(|| branches.last().expect("nonempty page").id.clone());
        Ok(PluginBranchPage { branches, next })
    }

    /// Validate an editing snapshot without changing source, artifacts, a branch or a runtime.
    pub fn prepare_checkpoint(
        &self,
        args: &CheckpointPlugin,
    ) -> Result<PluginArchive, PluginError> {
        ensure(
            args.changes.len() <= MAX_SOURCE_EDITS,
            "checkpoint exceeds 128 source edits",
        )?;
        // Bound the request before decoding or reading any retained file.
        ensure(
            serde_json::to_vec(args)?.len() <= MAX_SOURCE_CHECKPOINT_BYTES,
            "checkpoint request exceeds 256 KiB",
        )?;
        let transaction = self.connection.unchecked_transaction()?;
        if self.branch_head(&args.branch)? != args.expected_head {
            return Err(PluginError::Conflict);
        }
        let mut revision = self.revision(&args.expected_head)?;
        let plugin = revision.manifest.id.clone();
        let mut inline_bytes = 0;
        let mut supplied = BTreeMap::<ContentDigest, Vec<u8>>::new();
        for (path, edit) in &args.changes {
            ensure(
                !path.is_artifact(),
                "build artifacts cannot be edited as source",
            )?;
            match edit {
                PluginSourceEdit::Remove => {
                    ensure(
                        revision.files.remove(path).is_some(),
                        format!("source is absent: {path}"),
                    )?;
                }
                PluginSourceEdit::Put {
                    content_base64,
                    executable,
                } => {
                    ensure(
                        content_base64.len() <= MAX_SOURCE_EDIT_BYTES.div_ceil(3) * 4,
                        "inline source exceeds 128 KiB",
                    )?;
                    let bytes = STANDARD.decode(content_base64).map_err(|_| {
                        PluginError::Invalid("invalid base64 source content".into())
                    })?;
                    inline_bytes += bytes.len();
                    ensure(
                        inline_bytes <= MAX_SOURCE_EDIT_BYTES,
                        "inline source total exceeds 128 KiB",
                    )?;
                    let digest = content_digest(&bytes);
                    revision.files.insert(
                        path.clone(),
                        PackageFile {
                            digest: digest.clone(),
                            bytes: bytes.len() as u64,
                            executable: *executable,
                        },
                    );
                    supplied.insert(digest, bytes);
                }
                PluginSourceEdit::Copy {
                    revision: from,
                    path: source,
                } => {
                    let original = self.revision(from)?;
                    let file = source_file(&original, source)?.clone();
                    // Fetch only after the complete resulting tree has passed its byte quota.
                    revision.files.insert(path.clone(), file);
                }
            }
        }
        ensure(
            revision.files.len() <= MAX_PACKAGE_FILES,
            "source inventory exceeds package quota",
        )?;
        let total = revision
            .files
            .values()
            .try_fold(0u64, |total, file| total.checked_add(file.bytes))
            .ok_or_else(|| PluginError::Invalid("source size overflow".into()))?;
        ensure(total <= MAX_PACKAGE_BYTES, "source tree exceeds 256 MiB")?;
        let mut blobs = BTreeMap::new();
        for file in revision.files.values() {
            if !blobs.contains_key(&file.digest) {
                let bytes = match supplied.remove(&file.digest) {
                    Some(bytes) => bytes,
                    None => self.verified_source_bytes(file, 0..file.bytes)?,
                };
                ensure(
                    bytes.len() as u64 == file.bytes,
                    "source metadata length mismatch",
                )?;
                blobs.insert(file.digest.clone(), STANDARD.encode(bytes));
            }
        }
        let manifest_file = source_file(&revision, &PackagePath::new("plugin.json")?)?;
        ensure(
            manifest_file.bytes <= MAX_MANIFEST_BYTES as u64,
            "manifest exceeds byte limit",
        )?;
        revision.manifest = serde_json::from_slice(
            &STANDARD
                .decode(&blobs[&manifest_file.digest])
                .map_err(|_| PluginError::Invalid("invalid manifest content".into()))?,
        )?;
        ensure(
            revision.manifest.id == plugin,
            "checkpoint cannot change the plugin identity",
        )?;
        let declared: BTreeSet<_> = revision
            .manifest
            .source
            .files
            .iter()
            .chain(&revision.manifest.source.lockfiles)
            .chain([&revision.manifest.source.build_instructions])
            .cloned()
            .chain([PackagePath::new("plugin.json")?])
            .collect();
        ensure(
            declared == revision.files.keys().cloned().collect(),
            "manifest must declare the complete checkpoint source tree",
        )?;
        revision.parent = Some(args.expected_head.clone());
        revision.id = revision_digest(&revision)?;
        let archive = PluginArchive {
            format_version: 1,
            revision,
            artifacts: vec![],
            blobs,
        };
        validate_archive(&archive)?;
        transaction.commit()?;
        Ok(archive)
    }

    pub fn checkpoint(&mut self, args: &CheckpointPlugin) -> Result<PluginCheckpoint, PluginError> {
        let archive = self.prepare_checkpoint(args)?;
        self.commit_checkpoint(args, &archive)
    }

    /// Prepared bytes are immutable. Recheck the native branch head inside the write transaction.
    pub(crate) fn commit_checkpoint(
        &mut self,
        args: &CheckpointPlugin,
        archive: &PluginArchive,
    ) -> Result<PluginCheckpoint, PluginError> {
        ensure(
            archive.revision.parent.as_ref() == Some(&args.expected_head)
                && archive.artifacts.is_empty(),
            "invalid prepared source checkpoint",
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let matches: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM branches WHERE id=? AND head=? AND plugin=?)",
            params![
                args.branch.as_str(),
                args.expected_head.as_str(),
                archive.revision.manifest.id.as_str()
            ],
            |row| row.get(0),
        )?;
        if !matches {
            return Err(PluginError::Conflict);
        }
        store_archive(&transaction, archive)?;
        let changed = transaction.execute(
            "UPDATE branches SET head=? WHERE id=? AND head=? AND plugin=?",
            params![
                archive.revision.id.as_str(),
                args.branch.as_str(),
                args.expected_head.as_str(),
                archive.revision.manifest.id.as_str()
            ],
        )?;
        if changed != 1 {
            return Err(PluginError::Conflict);
        }
        transaction.execute(
            "DELETE FROM revision_refs WHERE owner_kind='branch' AND owner=?",
            [args.branch.as_str()],
        )?;
        transaction.execute(
            "INSERT INTO revision_refs VALUES('branch',?,?)",
            params![args.branch.as_str(), archive.revision.id.as_str()],
        )?;
        transaction.commit()?;
        Ok(PluginCheckpoint {
            branch: args.branch.clone(),
            revision: archive.revision.id.clone(),
            parent: args.expected_head.clone(),
        })
    }
}

fn source_file<'a>(
    revision: &'a PluginRevision,
    path: &PackagePath,
) -> Result<&'a PackageFile, PluginError> {
    ensure(
        !path.is_artifact(),
        "source reads cannot address build artifacts",
    )?;
    revision
        .files
        .get(path)
        .ok_or_else(|| PluginError::Missing(format!("source {path} in {}", revision.id)))
}
