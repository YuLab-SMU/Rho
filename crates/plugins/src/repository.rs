use crate::{PluginError, content_digest, ensure, validate_archive};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

/// New storage only. Never reads or migrates a previous Rho project database.
pub struct PluginRepository {
    root: PathBuf,
    pub(crate) connection: Connection,
}

pub type InstalledRevision = InstalledPluginRevision;

impl PluginRepository {
    pub fn open(root: &Path) -> Result<Self, PluginError> {
        // Refuse an incompatible existing catalog before any DDL or journal change.
        if root.join("catalog-v1.sqlite3").try_exists()? {
            let _ = Self::observe(root)?;
        }
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        let connection = Connection::open(root.join("catalog-v1.sqlite3"))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS plugin_schema(version INTEGER PRIMARY KEY CHECK(version=1));
            INSERT OR IGNORE INTO plugin_schema VALUES(1);
            CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, plugin TEXT NOT NULL, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, revision TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS blobs(digest TEXT PRIMARY KEY, bytes BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS source_files(revision TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE, path TEXT NOT NULL, digest TEXT NOT NULL REFERENCES blobs(digest), PRIMARY KEY(revision,path));
            CREATE TABLE IF NOT EXISTS artifact_files(artifact TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, path TEXT NOT NULL, digest TEXT NOT NULL REFERENCES blobs(digest), PRIMARY KEY(artifact,path));
            CREATE TABLE IF NOT EXISTS revision_refs(owner_kind TEXT NOT NULL, owner TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(owner_kind,owner,revision));
            CREATE INDEX IF NOT EXISTS revision_refs_target ON revision_refs(revision);
            CREATE TABLE IF NOT EXISTS branches(id TEXT PRIMARY KEY, plugin TEXT NOT NULL, head TEXT NOT NULL REFERENCES revisions(id), name TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS plugin_branch_origins(branch TEXT PRIMARY KEY REFERENCES branches(id), revision TEXT NOT NULL REFERENCES revisions(id));
            CREATE TABLE IF NOT EXISTS plugin_instances(id TEXT PRIMARY KEY, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS plugin_instance_activations(id TEXT PRIMARY KEY REFERENCES plugin_instances(id), document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS plugin_views(id TEXT PRIMARY KEY, project TEXT NOT NULL, principal TEXT NOT NULL, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS plugin_window_layouts(project TEXT NOT NULL, principal TEXT NOT NULL, window TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(project,principal,window));")?;
        crate::archives::initialize(&connection)?;
        crate::drafts::initialize(&connection)?;
        crate::scenarios::initialize(&connection)?;
        crate::test_projects::initialize(&connection)?;
        Ok(Self { root, connection })
    }

    /// Read-only discovery neither creates storage nor initializes a runtime.
    pub fn observe(root: &Path) -> Result<Option<Self>, PluginError> {
        if !root.join("catalog-v1.sqlite3").try_exists()? {
            return Ok(None);
        }
        let root = root.canonicalize()?;
        let connection = Connection::open_with_flags(
            root.join("catalog-v1.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let version: i64 =
            connection.query_row("SELECT version FROM plugin_schema", [], |row| row.get(0))?;
        ensure(version == 1, "unsupported plugin repository version")?;
        Ok(Some(Self { root, connection }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn import(&mut self, archive: &PluginArchive) -> Result<InstalledRevision, PluginError> {
        validate_archive(archive)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        store_archive(&transaction, archive)?;
        transaction.commit()?;
        self.inspect(&archive.revision.id)
    }

    pub fn revision(&self, id: &RevisionId) -> Result<PluginRevision, PluginError> {
        let document: String = self
            .connection
            .query_row(
                "SELECT document FROM revisions WHERE id=?",
                [id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| PluginError::Missing(id.to_string()))?;
        let revision: PluginRevision = serde_json::from_str(&document)?;
        ensure(
            &revision.id == id && crate::revision_digest(&revision)? == *id,
            "stored revision digest mismatch",
        )?;
        Ok(revision)
    }

    pub fn artifact(&self, id: &ArtifactId) -> Result<BuildArtifact, PluginError> {
        let document: String = self
            .connection
            .query_row(
                "SELECT document FROM artifacts WHERE id=?",
                [id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| PluginError::Missing(id.to_string()))?;
        let artifact: BuildArtifact = serde_json::from_str(&document)?;
        ensure(
            &artifact.id == id && crate::artifact_digest(&artifact)? == *id,
            "stored artifact digest mismatch",
        )?;
        Ok(artifact)
    }

    pub fn blob(&self, digest: &ContentDigest) -> Result<Vec<u8>, PluginError> {
        let bytes: Vec<u8> = self
            .connection
            .query_row(
                "SELECT bytes FROM blobs WHERE digest=?",
                [digest.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| PluginError::Missing(digest.to_string()))?;
        ensure(
            content_digest(&bytes) == *digest,
            "stored content digest mismatch",
        )?;
        Ok(bytes)
    }

    pub fn inspect(&self, id: &RevisionId) -> Result<InstalledRevision, PluginError> {
        let revision = self.revision(id)?;
        let artifacts = self
            .connection
            .prepare("SELECT id FROM artifacts WHERE revision=? ORDER BY id")?
            .query_map([id.as_str()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(ArtifactId::new)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(InstalledRevision {
            revision: id.clone(),
            plugin: revision.manifest.id,
            name: revision.manifest.name,
            version: revision.manifest.version,
            description: revision.manifest.description,
            artifacts,
            references: self.references(id)?,
        })
    }

    pub fn list(&self) -> Result<Vec<InstalledRevision>, PluginError> {
        let page = self.list_page(None, 100)?;
        ensure(
            page.next.is_none(),
            "catalog exceeds one page; use list_page with its continuation",
        )?;
        Ok(page.revisions)
    }

    pub fn list_page(
        &self,
        after: Option<&RevisionId>,
        limit: usize,
    ) -> Result<PluginRevisionPage, PluginError> {
        ensure(
            (1..=100).contains(&limit),
            "catalog page size must be 1–100",
        )?;
        let snapshot = self.connection.unchecked_transaction()?;
        let ids = self
            .connection
            .prepare("SELECT id FROM revisions WHERE (?1 IS NULL OR id>?1) ORDER BY id LIMIT ?2")?
            .query_map(
                params![after.map(RevisionId::as_str), (limit + 1) as u64],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = ids.len() > limit;
        let revisions: Vec<InstalledRevision> = ids
            .into_iter()
            .take(limit)
            .map(|id| self.inspect(&RevisionId::new(id)?))
            .collect::<Result<_, _>>()?;
        let next = has_more.then(|| revisions.last().expect("nonempty page").revision.clone());
        let total = self
            .connection
            .query_row("SELECT count(*) FROM revisions", [], |r| r.get(0))?;
        let page = PluginRevisionPage {
            revisions,
            next,
            total,
        };
        snapshot.commit()?;
        Ok(page)
    }

    pub fn compare(
        &self,
        before: &RevisionId,
        after: &RevisionId,
    ) -> Result<RevisionDifference, PluginError> {
        let snapshot = self.connection.unchecked_transaction()?;
        let previous = self.revision(before)?;
        let current = self.revision(after)?;
        ensure(
            previous.manifest.id == current.manifest.id,
            "revision comparison requires one plugin identity",
        )?;
        let paths: std::collections::BTreeSet<_> =
            previous.files.keys().chain(current.files.keys()).collect();
        let files = paths
            .into_iter()
            .filter_map(|path| {
                let before = previous.files.get(path);
                let after = current.files.get(path);
                (before != after).then(|| SourceFileDifference {
                    path: path.clone(),
                    before: before.cloned(),
                    after: after.cloned(),
                })
            })
            .collect();
        let difference = RevisionDifference {
            before: before.clone(),
            after: after.clone(),
            files,
        };
        snapshot.commit()?;
        Ok(difference)
    }

    pub fn export(&self, id: &RevisionId) -> Result<PluginArchive, PluginError> {
        let snapshot = self.connection.unchecked_transaction()?;
        let archive = self.export_selection(&ExportPluginArchive {
            revision: id.clone(), artifacts: self.inspect(id)?.artifacts,
        })?;
        snapshot.commit()?;
        Ok(archive)
    }

    pub fn export_selection(&self, args: &ExportPluginArchive) -> Result<PluginArchive, PluginError> {
        args.validate()?;
        let revision = self.revision(&args.revision)?;
        let artifacts = args.artifacts.iter().map(|id| {
            let artifact = self.artifact(id)?;
            ensure(artifact.revision == args.revision, "export artifact belongs to another revision")?;
            Ok(artifact)
        }).collect::<Result<Vec<_>, PluginError>>()?;
        let mut blobs = BTreeMap::new();
        for file in revision
            .files
            .values()
            .chain(artifacts.iter().flat_map(|a| a.files.values()))
        {
            if !blobs.contains_key(&file.digest) {
                blobs.insert(
                    file.digest.clone(),
                    STANDARD.encode(self.blob(&file.digest)?),
                );
            }
        }
        let archive = PluginArchive {
            format_version: 1,
            revision,
            artifacts,
            blobs,
        };
        validate_archive(&archive)?;
        Ok(archive)
    }

    /// No overwrite: exports are reviewable artifacts, never silent replacement.
    pub fn export_file(&self, id: &RevisionId, destination: &Path) -> Result<(), PluginError> {
        let bytes = serde_json::to_vec(&self.export(id)?)?;
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        temp.persist_noclobber(destination)
            .map_err(|e| PluginError::Io(e.error))?;
        Ok(())
    }

    pub fn references(&self, id: &RevisionId) -> Result<Vec<String>, PluginError> {
        let rows = self.connection.prepare("SELECT owner_kind || ':' || owner FROM revision_refs WHERE revision=? ORDER BY owner_kind,owner")?
            .query_map([id.as_str()], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Called only by the owning core service; not exposed as a plugin write API.
    pub fn retain(
        &mut self,
        owner_kind: &str,
        owner: &str,
        revision: &RevisionId,
    ) -> Result<(), PluginError> {
        ensure(
            matches!(
                owner_kind,
                "instance" | "view" | "operation" | "management" | "build" | "scenario" | "document" | "checkpoint" | "test_project" | "archive_export" | "archive_import"
            ),
            "unknown reference owner",
        )?;
        ensure(
            !owner.is_empty() && owner.len() <= 256,
            "invalid reference owner",
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure(
            transaction
                .query_row(
                    "SELECT 1 FROM revisions WHERE id=?",
                    [revision.as_str()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some(),
            "revision is missing",
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO revision_refs VALUES(?,?,?)",
            params![owner_kind, owner, revision.as_str()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn release_reference(
        &mut self,
        owner_kind: &str,
        owner: &str,
        revision: &RevisionId,
    ) -> Result<(), PluginError> {
        ensure(
            matches!(
                owner_kind,
                "instance" | "view" | "operation" | "management" | "build" | "scenario" | "document" | "checkpoint" | "test_project" | "archive_export" | "archive_import"
            ),
            "unknown reference owner",
        )?;
        self.connection.execute(
            "DELETE FROM revision_refs WHERE owner_kind=? AND owner=? AND revision=?",
            params![owner_kind, owner, revision.as_str()],
        )?;
        Ok(())
    }

    pub fn create_branch(
        &mut self,
        from: &RevisionId,
        name: &str,
    ) -> Result<BranchId, PluginError> {
        ensure(
            !name.trim().is_empty() && name.len() <= 128 && !name.chars().any(char::is_control),
            "invalid branch name",
        )?;
        let revision = self.revision(from)?;
        let id = BranchId::new(uuid::Uuid::new_v4().to_string())?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO branches VALUES(?,?,?,?)",
            params![
                id.as_str(),
                revision.manifest.id.as_str(),
                from.as_str(),
                name
            ],
        )?;
        transaction.execute(
            "INSERT INTO revision_refs VALUES('branch',?,?)",
            params![id.as_str(), from.as_str()],
        )?;
        transaction.execute(
            "INSERT INTO plugin_branch_origins VALUES(?,?)",
            params![id.as_str(), from.as_str()],
        )?;
        transaction.commit()?;
        Ok(id)
    }

    pub fn branch_head(&self, branch: &BranchId) -> Result<RevisionId, PluginError> {
        let head: String = self
            .connection
            .query_row(
                "SELECT head FROM branches WHERE id=?",
                [branch.as_str()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| PluginError::Missing(branch.to_string()))?;
        Ok(RevisionId::new(head)?)
    }

    pub fn advance_branch(
        &mut self,
        branch: &BranchId,
        expected: &RevisionId,
        next: &RevisionId,
    ) -> Result<(), PluginError> {
        let next_revision = self.revision(next)?;
        ensure(
            next_revision.parent.as_ref() == Some(expected),
            "checkpoint parent must match the branch head",
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE branches SET head=? WHERE id=? AND head=? AND plugin=?",
            params![
                next.as_str(),
                branch.as_str(),
                expected.as_str(),
                next_revision.manifest.id.as_str()
            ],
        )?;
        if changed != 1 {
            return Err(PluginError::Conflict);
        }
        transaction.execute(
            "DELETE FROM revision_refs WHERE owner_kind='branch' AND owner=?",
            [branch.as_str()],
        )?;
        transaction.execute(
            "INSERT INTO revision_refs VALUES('branch',?,?)",
            params![branch.as_str(), next.as_str()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove(&mut self, id: &RevisionId) -> Result<(), PluginError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let refs = transaction.prepare("SELECT owner_kind || ':' || owner FROM revision_refs WHERE revision=? ORDER BY owner_kind,owner")?
            .query_map([id.as_str()], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        if !refs.is_empty() {
            return Err(PluginError::Referenced(refs));
        }
        let count = transaction.execute("DELETE FROM revisions WHERE id=?", [id.as_str()])?;
        if count == 0 {
            return Err(PluginError::Missing(id.to_string()));
        }
        transaction.execute(
            "DELETE FROM revision_refs WHERE owner_kind IN ('revision','dependency') AND owner=?",
            [id.as_str()],
        )?;
        transaction.execute("DELETE FROM blobs WHERE NOT EXISTS(SELECT 1 FROM source_files WHERE source_files.digest=blobs.digest) AND NOT EXISTS(SELECT 1 FROM artifact_files WHERE artifact_files.digest=blobs.digest)", [])?;
        transaction.commit()?;
        Ok(())
    }
}

/// Caller validates the archive and owns the encompassing transaction.
pub(crate) fn store_archive(
    transaction: &rusqlite::Transaction<'_>,
    archive: &PluginArchive,
) -> Result<(), PluginError> {
    let revision = &archive.revision;
    let document = serde_json::to_string(revision)?;
    if let Some(existing) = transaction
        .query_row(
            "SELECT document FROM revisions WHERE id=?",
            [revision.id.as_str()],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        ensure(
            serde_json::from_str::<PluginRevision>(&existing)? == *revision,
            "immutable revision collision",
        )?;
    } else {
        transaction.execute(
            "INSERT INTO revisions VALUES(?,?,?)",
            params![
                revision.id.as_str(),
                revision.manifest.id.as_str(),
                document
            ],
        )?;
    }
    for (digest, encoded) in &archive.blobs {
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|e| PluginError::Invalid(e.to_string()))?;
        if let Some(existing) = transaction
            .query_row(
                "SELECT bytes FROM blobs WHERE digest=?",
                [digest.as_str()],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .optional()?
        {
            ensure(existing == bytes, "immutable blob collision or corruption")?;
        } else {
            transaction.execute(
                "INSERT INTO blobs VALUES(?,?)",
                params![digest.as_str(), bytes],
            )?;
        }
    }
    for (path, file) in &revision.files {
        transaction.execute(
            "INSERT OR IGNORE INTO source_files VALUES(?,?,?)",
            params![revision.id.as_str(), path.as_str(), file.digest.as_str()],
        )?;
    }
    for artifact in &archive.artifacts {
        if let Some(existing) = transaction
            .query_row(
                "SELECT document FROM artifacts WHERE id=?",
                [artifact.id.as_str()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            ensure(
                serde_json::from_str::<BuildArtifact>(&existing)? == *artifact,
                "immutable artifact collision",
            )?;
        } else {
            transaction.execute(
                "INSERT INTO artifacts VALUES(?,?,?)",
                params![
                    artifact.id.as_str(),
                    revision.id.as_str(),
                    serde_json::to_string(artifact)?
                ],
            )?;
        }
        for (path, file) in &artifact.files {
            transaction.execute(
                "INSERT OR IGNORE INTO artifact_files VALUES(?,?,?)",
                params![artifact.id.as_str(), path.as_str(), file.digest.as_str()],
            )?;
        }
    }
    // Repeated builds/imports must leave one exportable package, rather than
    // individually valid artifacts accumulating beyond the archive quota. Check
    // the complete retained inventory inside the same rollback-capable transaction.
    let documents = transaction.prepare("SELECT document FROM artifacts WHERE revision=? LIMIT 33")?
        .query_map([revision.id.as_str()], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ensure(documents.len() <= 32, "retained artifact inventory exceeds limit")?;
    let mut files = revision.files.len();
    let mut bytes: u64 = revision.files.values().map(|file|file.bytes).sum();
    for document in documents {
        let artifact: BuildArtifact = serde_json::from_str(&document)?;
        ensure(artifact.revision == revision.id && crate::artifact_digest(&artifact)? == artifact.id, "stored artifact identity mismatch")?;
        files = files.checked_add(artifact.files.len()).ok_or_else(||PluginError::Invalid("package inventory overflow".into()))?;
        for file in artifact.files.values() {
            bytes = bytes.checked_add(file.bytes).ok_or_else(||PluginError::Invalid("package size overflow".into()))?;
        }
    }
    ensure(files <= MAX_PACKAGE_FILES && bytes <= MAX_PACKAGE_BYTES, "retained package exceeds archive quota")?;
    if let Some(parent) = &revision.parent {
        transaction.execute(
            "INSERT OR IGNORE INTO revision_refs VALUES('revision',?,?)",
            params![revision.id.as_str(), parent.as_str()],
        )?;
    }
    // Dependencies can be absent at import. Activation must resolve exact revisions.
    for dependency in revision.manifest.dependencies.values() {
        transaction.execute(
            "INSERT OR IGNORE INTO revision_refs VALUES('dependency',?,?)",
            params![revision.id.as_str(), dependency.revision.as_str()],
        )?;
    }
    Ok(())
}
