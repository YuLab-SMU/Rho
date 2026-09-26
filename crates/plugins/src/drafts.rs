//! Current synchronized document bytes. This owner neither reads project files
//! nor interprets metadata, starts a runtime, or attests to a scientific result.
use crate::{PluginError, PluginRepository, content_digest, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const STAGE_LIFETIME_MS: u64 = 10 * 60 * 1000;
const MAX_SCOPE_CHUNK_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SCOPE_DRAFTS: u32 = 256;
const MAX_SCOPE_IDENTITIES: u32 = 4096;
const MAX_SCOPE_STAGES: u32 = 8192;
const MAX_SCOPE_ACCEPTED_SAVES: u32 = 256;

pub(crate) fn initialize(connection: &Connection) -> Result<(), PluginError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS document_drafts(
        project TEXT NOT NULL, principal TEXT NOT NULL, window TEXT NOT NULL,
        id TEXT NOT NULL, document TEXT NOT NULL, discarded INTEGER NOT NULL,
        PRIMARY KEY(project,principal,window,id));
        CREATE TABLE IF NOT EXISTS draft_chunks(
        project TEXT NOT NULL, principal TEXT NOT NULL, window TEXT NOT NULL,
        digest TEXT NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY(project,principal,window,digest));
        CREATE TABLE IF NOT EXISTS draft_chunk_stages(
        project TEXT NOT NULL, principal TEXT NOT NULL, window TEXT NOT NULL,
        draft TEXT NOT NULL, upload TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(project,principal,window,draft,upload,digest),
        FOREIGN KEY(project,principal,window,digest) REFERENCES draft_chunks(project,principal,window,digest));
        CREATE TABLE IF NOT EXISTS draft_chunk_refs(
        project TEXT NOT NULL, principal TEXT NOT NULL, window TEXT NOT NULL,
        draft TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(project,principal,window,draft,digest),
        FOREIGN KEY(project,principal,window,draft) REFERENCES document_drafts(project,principal,window,id),
        FOREIGN KEY(project,principal,window,digest) REFERENCES draft_chunks(project,principal,window,digest));
        CREATE INDEX IF NOT EXISTS draft_refs_content ON draft_chunk_refs(project,principal,window,digest);
        CREATE INDEX IF NOT EXISTS draft_stages_content ON draft_chunk_stages(project,principal,window,digest);
        CREATE INDEX IF NOT EXISTS draft_stages_expiry ON draft_chunk_stages(project,principal,expires);
        CREATE TABLE IF NOT EXISTS draft_upload_operations(
        project TEXT NOT NULL, principal TEXT NOT NULL, operation TEXT NOT NULL,
        window TEXT NOT NULL, draft TEXT NOT NULL, upload TEXT NOT NULL,
        fingerprint TEXT NOT NULL, revision TEXT NOT NULL,
        PRIMARY KEY(project,principal,operation));
        CREATE INDEX IF NOT EXISTS draft_upload_identity ON draft_upload_operations(project,principal,window,draft,upload);
        CREATE TABLE IF NOT EXISTS draft_operation_chunks(
        project TEXT NOT NULL, principal TEXT NOT NULL, operation TEXT NOT NULL,
        window TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(project,principal,operation,digest),
        FOREIGN KEY(project,principal,operation) REFERENCES draft_upload_operations(project,principal,operation),
        FOREIGN KEY(project,principal,window,digest) REFERENCES draft_chunks(project,principal,window,digest));
        CREATE INDEX IF NOT EXISTS draft_operation_content ON draft_operation_chunks(project,principal,window,digest);")?;
    Ok(())
}

fn reference_owner(
    project: &ProjectId,
    principal: &PrincipalId,
    window: &WindowId,
    draft: &DraftId,
) -> String {
    format!(
        "{}:{draft}",
        content_digest(format!("{project}:{principal}:{window}").as_bytes())
    )
}

fn upload_owner(project: &ProjectId, principal: &PrincipalId, operation: &OperationId) -> String {
    format!(
        "draft-operation:{}:{operation}",
        content_digest(format!("{project}:{principal}").as_bytes())
    )
}

fn observed(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    window: &WindowId,
    id: &DraftId,
) -> Result<Option<DocumentDraft>, PluginError> {
    let value = connection.query_row(
        "SELECT document FROM document_drafts WHERE project=? AND principal=? AND window=? AND id=?",
        params![project.as_str(), principal.as_str(), window.as_str(), id.as_str()],
        |row| row.get::<_, String>(0)).optional()?;
    value
        .map(|value| {
            let record: DocumentDraft = serde_json::from_str(&value)?;
            ensure(
                &record.project == project
                    && &record.principal == principal
                    && &record.window == window
                    && &record.draft == id,
                "draft does not match its stored scope",
            )?;
            record.content.validate()?;
            Ok(record)
        })
        .transpose()
}

fn chunk_bytes(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    window: &WindowId,
    chunk: &DraftChunkReference,
) -> Result<Vec<u8>, PluginError> {
    let bytes: Option<Vec<u8>> = connection.query_row(
        "SELECT bytes FROM draft_chunks WHERE project=? AND principal=? AND window=? AND digest=?",
        params![project.as_str(), principal.as_str(), window.as_str(), chunk.digest.as_str()],
        |row| row.get(0)).optional()?;
    let bytes = bytes
        .ok_or_else(|| PluginError::Missing("draft chunk is unavailable in this window".into()))?;
    ensure(
        bytes.len() == chunk.bytes as usize && content_digest(&bytes) == chunk.digest,
        "draft chunk length or digest changed",
    )?;
    Ok(bytes)
}

fn collect_expired(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    now_ms: u64,
) -> Result<(), PluginError> {
    let now = i64::try_from(now_ms)
        .map_err(|_| PluginError::Invalid("draft clock exceeds storage range".into()))?;
    connection.execute(
        "DELETE FROM draft_chunk_stages AS s WHERE project=? AND principal=? AND expires<=?
        AND NOT EXISTS(SELECT 1 FROM draft_upload_operations AS o WHERE o.project=s.project AND o.principal=s.principal
        AND o.window=s.window AND o.draft=s.draft AND o.upload=s.upload)",
        params![project.as_str(), principal.as_str(), now],
    )?;
    collect_unreferenced(connection, project, principal)
}

fn collect_unreferenced(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
) -> Result<(), PluginError> {
    connection.execute("DELETE FROM draft_chunks AS c WHERE project=? AND principal=?
        AND NOT EXISTS(SELECT 1 FROM draft_chunk_refs AS r WHERE r.project=c.project AND r.principal=c.principal
        AND r.window=c.window AND r.digest=c.digest)
        AND NOT EXISTS(SELECT 1 FROM draft_chunk_stages AS s WHERE s.project=c.project AND s.principal=c.principal
        AND s.window=c.window AND s.digest=c.digest)
        AND NOT EXISTS(SELECT 1 FROM draft_operation_chunks AS o WHERE o.project=c.project AND o.principal=c.principal
        AND o.window=c.window AND o.digest=c.digest)", params![project.as_str(), principal.as_str()])?;
    Ok(())
}

fn verify_staged_content(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    args: &SaveDocumentDraft,
) -> Result<(), PluginError> {
    let mut hash = Sha256::new();
    for chunk in &args.content.chunks {
        let staged: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM draft_chunk_stages
                WHERE project=? AND principal=? AND window=? AND draft=? AND upload=? AND digest=?)",
                params![project.as_str(), principal.as_str(), args.window.as_str(), args.draft.as_str(), args.upload.as_str(), chunk.digest.as_str()], |row| row.get(0))?;
        ensure(
            staged,
            "draft chunk has no current lease for this captured save",
        )?;
        hash.update(chunk_bytes(
            connection,
            project,
            principal,
            &args.window,
            chunk,
        )?);
    }
    ensure(
        format!("sha256:{:x}", hash.finalize()) == args.content.digest.as_str(),
        "assembled draft digest does not match its declaration",
    )?;
    Ok(())
}

impl PluginRepository {
    /// Core admission retention only, never a plugin-callable mutation. The
    /// Operation owner supplies its original identity after accepting this exact
    /// capture. This stores leases, not an independent execution/result journal.
    pub fn retain_draft_upload(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        operation: &OperationId,
        args: &SaveDocumentDraft,
        now_ms: u64,
    ) -> Result<(), PluginError> {
        args.validate()?;
        let fingerprint = crate::package::document_digest(args)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let previous: Option<String> = transaction.query_row("SELECT fingerprint FROM draft_upload_operations WHERE project=? AND principal=? AND operation=?",
            params![project.as_str(), principal.as_str(), operation.as_str()], |row| row.get(0)).optional()?;
        if let Some(previous) = previous {
            ensure(
                previous == fingerprint,
                "original draft operation retains a different capture",
            )?;
            return Ok(());
        }
        collect_expired(&transaction, project, principal, now_ms)?;
        let count: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM draft_upload_operations WHERE project=? AND principal=?",
            params![project.as_str(), principal.as_str()],
            |row| row.get(0),
        )?;
        ensure(
            count < MAX_SCOPE_ACCEPTED_SAVES,
            "accepted draft save quota reached",
        )?;
        let source: Option<String> = transaction
            .query_row(
                "SELECT document FROM revisions WHERE id=?",
                [args.source.revision.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let source: PluginRevision = serde_json::from_str(
            &source.ok_or_else(|| PluginError::Missing(args.source.revision.to_string()))?,
        )?;
        ensure(
            source.id == args.source.revision
                && source
                    .manifest
                    .views
                    .iter()
                    .any(|view| view.id == args.source.contribution),
            "draft source is not a view contributed by its exact revision",
        )?;
        match (
            observed(&transaction, project, principal, &args.window, &args.draft)?,
            args.expected_version,
        ) {
            (None, None) => (),
            (Some(old), Some(version))
                if !old.discarded && old.version == version && old.source == args.source =>
            {
                ()
            }
            _ => return Err(PluginError::Conflict),
        }
        verify_staged_content(&transaction, project, principal, args)?;
        transaction.execute(
            "INSERT INTO draft_upload_operations VALUES(?,?,?,?,?,?,?,?)",
            params![
                project.as_str(),
                principal.as_str(),
                operation.as_str(),
                args.window.as_str(),
                args.draft.as_str(),
                args.upload.as_str(),
                fingerprint,
                args.source.revision.as_str()
            ],
        )?;
        for digest in args
            .content
            .chunks
            .iter()
            .map(|chunk| &chunk.digest)
            .collect::<BTreeSet<_>>()
        {
            transaction.execute(
                "INSERT INTO draft_operation_chunks VALUES(?,?,?,?,?)",
                params![
                    project.as_str(),
                    principal.as_str(),
                    operation.as_str(),
                    args.window.as_str(),
                    digest.as_str()
                ],
            )?;
        }
        transaction.execute(
            "INSERT INTO revision_refs VALUES('document',?,?)",
            params![
                upload_owner(project, principal, operation),
                args.source.revision.as_str()
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// The core must establish original settlement (or explicit resolution of
    /// retained recovery) before releasing. A timeout or disconnected view is
    /// insufficient. Releasing never repeats a save or changes its outcome.
    pub fn release_draft_upload(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        operation: &OperationId,
        now_ms: u64,
    ) -> Result<(), PluginError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let revision: Option<String> = transaction.query_row("SELECT revision FROM draft_upload_operations WHERE project=? AND principal=? AND operation=?",
            params![project.as_str(), principal.as_str(), operation.as_str()], |row| row.get(0)).optional()?;
        let Some(revision) = revision else {
            return Ok(());
        };
        transaction.execute(
            "DELETE FROM draft_operation_chunks WHERE project=? AND principal=? AND operation=?",
            params![project.as_str(), principal.as_str(), operation.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM draft_upload_operations WHERE project=? AND principal=? AND operation=?",
            params![project.as_str(), principal.as_str(), operation.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM revision_refs WHERE owner_kind='document' AND owner=? AND revision=?",
            params![upload_owner(project, principal, operation), revision],
        )?;
        collect_expired(&transaction, project, principal, now_ms)?;
        transaction.commit()?;
        Ok(())
    }

    /// Stage at most 64 KiB under trusted Host scope and time. This is not a saved
    /// draft. Unreferenced staged bytes expire; reading never evicts or creates.
    pub fn stage_draft_chunk(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: StageDraftChunk,
        now_ms: u64,
    ) -> Result<DraftChunkReference, PluginError> {
        ensure(
            args.base64.len() <= (MAX_DRAFT_CHUNK_BYTES as usize).div_ceil(3) * 4,
            "encoded draft chunk exceeds quota",
        )?;
        let bytes = STANDARD
            .decode(&args.base64)
            .map_err(|e| PluginError::Invalid(e.to_string()))?;
        ensure(
            !bytes.is_empty() && bytes.len() <= MAX_DRAFT_CHUNK_BYTES as usize,
            "draft chunk must contain 1–65536 bytes",
        )?;
        ensure(
            content_digest(&bytes) == args.digest,
            "draft chunk digest does not match its bytes",
        )?;
        let expires = now_ms
            .checked_add(STAGE_LIFETIME_MS)
            .and_then(|n| i64::try_from(n).ok())
            .ok_or_else(|| PluginError::Invalid("draft clock exceeds storage range".into()))?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        collect_expired(&transaction, project, principal, now_ms)?;
        ensure(
            !observed(&transaction, project, principal, &args.window, &args.draft)?
                .is_some_and(|draft| draft.discarded),
            "discarded draft identity cannot receive another upload",
        )?;
        let old: Option<Vec<u8>> = transaction.query_row(
            "SELECT bytes FROM draft_chunks WHERE project=? AND principal=? AND window=? AND digest=?",
            params![project.as_str(), principal.as_str(), args.window.as_str(), args.digest.as_str()],
            |row| row.get(0)).optional()?;
        if let Some(old) = &old {
            ensure(
                old == &bytes,
                "immutable draft chunk collision or corruption",
            )?;
        }
        let retained: u64 = transaction.query_row("SELECT COALESCE(SUM(length(bytes)),0) FROM draft_chunks WHERE project=? AND principal=?",
            params![project.as_str(), principal.as_str()], |row| row.get(0))?;
        ensure(
            retained + if old.is_some() { 0 } else { bytes.len() as u64 } <= MAX_SCOPE_CHUNK_BYTES,
            "draft content quota reached; explicitly discard unused drafts",
        )?;
        let staged: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM draft_chunk_stages
            WHERE project=? AND principal=? AND window=? AND draft=? AND upload=? AND digest=?)",
            params![
                project.as_str(),
                principal.as_str(),
                args.window.as_str(),
                args.draft.as_str(),
                args.upload.as_str(),
                args.digest.as_str()
            ],
            |row| row.get(0),
        )?;
        let stages: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM draft_chunk_stages WHERE project=? AND principal=?",
            params![project.as_str(), principal.as_str()],
            |row| row.get(0),
        )?;
        ensure(
            staged || stages < MAX_SCOPE_STAGES,
            "draft staging count quota reached",
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO draft_chunks VALUES(?,?,?,?,?)",
            params![
                project.as_str(),
                principal.as_str(),
                args.window.as_str(),
                args.digest.as_str(),
                bytes
            ],
        )?;
        transaction.execute("INSERT INTO draft_chunk_stages VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(project,principal,window,draft,upload,digest) DO UPDATE SET expires=MAX(expires,excluded.expires)",
            params![project.as_str(), principal.as_str(), args.window.as_str(), args.draft.as_str(), args.upload.as_str(), args.digest.as_str(), expires])?;
        transaction.commit()?;
        Ok(DraftChunkReference {
            digest: args.digest,
            bytes: bytes.len() as u32,
        })
    }

    /// One scoped observation. Missing state is not a new draft or a recovered
    /// renderer, and a discarded identity stays distinguishable from absence.
    pub fn document_draft(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: &DocumentDraftArguments,
    ) -> Result<Option<DocumentDraft>, PluginError> {
        observed(
            &self.connection,
            project,
            principal,
            &args.window,
            &args.draft,
        )
    }

    /// Publish the complete verified content, metadata, exact source reference
    /// and owner version in one transaction. Native file/runtime state is absent.
    pub fn save_document_draft(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: SaveDocumentDraft,
        now_ms: u64,
    ) -> Result<DocumentDraft, PluginError> {
        args.validate()?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let source: Option<String> = transaction
            .query_row(
                "SELECT document FROM revisions WHERE id=?",
                [args.source.revision.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let source: PluginRevision = serde_json::from_str(
            &source.ok_or_else(|| PluginError::Missing(args.source.revision.to_string()))?,
        )?;
        ensure(
            source.id == args.source.revision
                && source
                    .manifest
                    .views
                    .iter()
                    .any(|view| view.id == args.source.contribution),
            "draft source is not a view contributed by its exact revision",
        )?;
        collect_expired(&transaction, project, principal, now_ms)?;
        let previous = observed(&transaction, project, principal, &args.window, &args.draft)?;
        let version = match (&previous, args.expected_version) {
            (None, None) => {
                let (count, live): (u32, u32) = transaction.query_row(
                    "SELECT COUNT(*),COALESCE(SUM(discarded=0),0) FROM document_drafts WHERE project=? AND principal=?",
                    params![project.as_str(), principal.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))?;
                ensure(
                    count < MAX_SCOPE_IDENTITIES && live < MAX_SCOPE_DRAFTS,
                    "document draft count quota reached",
                )?;
                1
            }
            (Some(old), Some(version))
                if !old.discarded && old.version == version && old.source == args.source =>
            {
                version
                    .checked_add(1)
                    .ok_or_else(|| PluginError::Invalid("draft version exhausted".into()))?
            }
            _ => return Err(PluginError::Conflict),
        };
        verify_staged_content(&transaction, project, principal, &args)?;
        let record = DocumentDraft {
            draft: args.draft,
            project: project.clone(),
            principal: principal.clone(),
            window: args.window,
            source: args.source,
            version,
            content: args.content,
            metadata: args.metadata,
            discarded: false,
        };
        transaction.execute(
            "INSERT INTO document_drafts VALUES(?,?,?,?,?,0)
            ON CONFLICT(project,principal,window,id) DO UPDATE SET document=excluded.document",
            params![
                project.as_str(),
                principal.as_str(),
                record.window.as_str(),
                record.draft.as_str(),
                serde_json::to_string(&record)?
            ],
        )?;
        transaction.execute(
            "DELETE FROM draft_chunk_refs WHERE project=? AND principal=? AND window=? AND draft=?",
            params![
                project.as_str(),
                principal.as_str(),
                record.window.as_str(),
                record.draft.as_str()
            ],
        )?;
        for digest in record
            .content
            .chunks
            .iter()
            .map(|chunk| &chunk.digest)
            .collect::<BTreeSet<_>>()
        {
            transaction.execute(
                "INSERT INTO draft_chunk_refs VALUES(?,?,?,?,?)",
                params![
                    project.as_str(),
                    principal.as_str(),
                    record.window.as_str(),
                    record.draft.as_str(),
                    digest.as_str()
                ],
            )?;
        }
        transaction.execute(
            "INSERT OR IGNORE INTO revision_refs VALUES('document',?,?)",
            params![
                reference_owner(project, principal, &record.window, &record.draft),
                record.source.revision.as_str()
            ],
        )?;
        transaction.execute("DELETE FROM draft_chunk_stages WHERE project=? AND principal=? AND window=? AND draft=? AND upload=?",
            params![project.as_str(), principal.as_str(), record.window.as_str(), record.draft.as_str(), args.upload.as_str()])?;
        collect_unreferenced(&transaction, project, principal)?;
        transaction.commit()?;
        Ok(record)
    }

    /// Reads are version-pinned bounded byte pages. A transaction prevents mixed
    /// chunks if another repository connection saves or discards concurrently.
    pub fn read_document_draft(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: ReadDocumentDraft,
    ) -> Result<DocumentDraftChunk, PluginError> {
        ensure(
            args.limit > 0 && args.limit <= MAX_DRAFT_CHUNK_BYTES,
            "draft read limit must be 1–65536 bytes",
        )?;
        let transaction = self.connection.unchecked_transaction()?;
        let record = observed(&transaction, project, principal, &args.window, &args.draft)?
            .ok_or_else(|| PluginError::Missing(args.draft.to_string()))?;
        if record.discarded || record.version != args.expected_version {
            return Err(PluginError::Conflict);
        }
        ensure(
            args.offset <= record.content.bytes,
            "draft read offset exceeds length",
        )?;
        let end = record
            .content
            .bytes
            .min(args.offset.saturating_add(args.limit));
        let mut bytes = Vec::with_capacity((end - args.offset) as usize);
        let mut position = args.offset;
        while position < end {
            let index = position / MAX_DRAFT_CHUNK_BYTES;
            let chunk = &record.content.chunks[index as usize];
            let content = chunk_bytes(&transaction, project, principal, &args.window, chunk)?;
            let start = (position % MAX_DRAFT_CHUNK_BYTES) as usize;
            let count = (content.len() - start).min((end - position) as usize);
            bytes.extend_from_slice(&content[start..start + count]);
            position += count as u32;
        }
        transaction.commit()?;
        Ok(DocumentDraftChunk {
            draft: record.draft,
            version: record.version,
            digest: record.content.digest,
            offset: args.offset,
            base64: STANDARD.encode(bytes),
            next: (end < record.content.bytes).then_some(end),
        })
    }

    /// Discard only the exact acknowledged draft. Keep its identity tombstone;
    /// delayed creation and updates cannot silently resurrect removed content.
    pub fn discard_document_draft(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: DiscardDocumentDraft,
    ) -> Result<DocumentDraft, PluginError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut record = observed(&transaction, project, principal, &args.window, &args.draft)?
            .ok_or_else(|| PluginError::Missing(args.draft.to_string()))?;
        if record.discarded
            || record.version != args.expected_version
            || record.source != args.source
        {
            return Err(PluginError::Conflict);
        }
        let accepted: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM draft_upload_operations WHERE project=? AND principal=? AND window=? AND draft=?)",
            params![project.as_str(), principal.as_str(), args.window.as_str(), args.draft.as_str()], |row| row.get(0))?;
        ensure(
            !accepted,
            "draft has accepted saves awaiting original settlement",
        )?;
        record.version = record
            .version
            .checked_add(1)
            .ok_or_else(|| PluginError::Invalid("draft version exhausted".into()))?;
        record.discarded = true;
        record.metadata = serde_json::Value::Null;
        record.content = DraftContent {
            digest: content_digest(&[]),
            bytes: 0,
            chunks: vec![],
        };
        transaction.execute("UPDATE document_drafts SET document=?,discarded=1 WHERE project=? AND principal=? AND window=? AND id=?",
            params![serde_json::to_string(&record)?, project.as_str(), principal.as_str(), args.window.as_str(), args.draft.as_str()])?;
        transaction.execute(
            "DELETE FROM draft_chunk_refs WHERE project=? AND principal=? AND window=? AND draft=?",
            params![
                project.as_str(),
                principal.as_str(),
                args.window.as_str(),
                args.draft.as_str()
            ],
        )?;
        transaction.execute("DELETE FROM draft_chunk_stages WHERE project=? AND principal=? AND window=? AND draft=?",
            params![project.as_str(), principal.as_str(), args.window.as_str(), args.draft.as_str()])?;
        transaction.execute(
            "DELETE FROM revision_refs WHERE owner_kind='document' AND owner=? AND revision=?",
            params![
                reference_owner(project, principal, &args.window, &args.draft),
                record.source.revision.as_str()
            ],
        )?;
        collect_unreferenced(&transaction, project, principal)?;
        transaction.commit()?;
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Fixture {
        _temp: tempfile::TempDir,
        repo: PluginRepository,
        project: ProjectId,
        principal: PrincipalId,
        source: DraftSource,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let package = temp.path().join("source");
            fs::create_dir_all(package.join("dist")).unwrap();
            for (file, bytes) in [
                ("index.html", "<p>Draft fixture</p>"),
                ("dist/index.html", "<p>Draft fixture</p>"),
                ("dependencies.lock", "No dependencies."),
                ("BUILD.md", "Copy index.html to dist/index.html."),
            ] {
                fs::write(package.join(file), bytes).unwrap();
            }
            fs::write(package.join("plugin.json"), serde_json::to_vec(&json!({
                "protocol_version":1,"id":"fixture.draft","name":"Draft fixture","version":"1","description":"Generic draft owner test","license":"MIT",
                "source":{"files":["index.html"],"lockfiles":["dependencies.lock"],"build_instructions":"BUILD.md","build":null},
                "dependencies":{},"requires":[],"capabilities":[],"contexts":[],"backend":null,
                "views":[{"id":"editor","title":"Editor","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],
                "configuration_schema":{"type":"object"},"default_configuration":{}
            })).unwrap()).unwrap();
            let archive = crate::snapshot_directory(&package, None, "ui-web").unwrap();
            let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
            repo.import(&archive).unwrap();
            Self {
                _temp: temp,
                repo,
                project: ProjectId::new("project").unwrap(),
                principal: PrincipalId::new("principal").unwrap(),
                source: DraftSource {
                    revision: archive.revision.id,
                    contribution: ContributionId::new("editor").unwrap(),
                },
            }
        }
        fn stage(
            &mut self,
            draft: &str,
            upload: &str,
            bytes: &[u8],
            now: u64,
        ) -> SaveDocumentDraft {
            let window = WindowId::new("window").unwrap();
            let draft = DraftId::new(draft).unwrap();
            let upload = RequestId::new(upload).unwrap();
            let chunks = bytes
                .chunks(MAX_DRAFT_CHUNK_BYTES as usize)
                .map(|part| {
                    self.repo
                        .stage_draft_chunk(
                            &self.project,
                            &self.principal,
                            StageDraftChunk {
                                window: window.clone(),
                                draft: draft.clone(),
                                upload: upload.clone(),
                                digest: content_digest(part),
                                base64: STANDARD.encode(part),
                            },
                            now,
                        )
                        .unwrap()
                })
                .collect();
            SaveDocumentDraft {
                window,
                draft,
                upload,
                source: self.source.clone(),
                expected_version: None,
                content: DraftContent {
                    digest: content_digest(bytes),
                    bytes: bytes.len() as u32,
                    chunks,
                },
                metadata: json!({"selection":[1,2]}),
            }
        }
        fn save(&mut self, args: SaveDocumentDraft) -> DocumentDraft {
            self.repo
                .save_document_draft(&self.project, &self.principal, args, 100)
                .unwrap()
        }
        fn inspect(&self, id: &str) -> Option<DocumentDraft> {
            self.repo
                .document_draft(
                    &self.project,
                    &self.principal,
                    &DocumentDraftArguments {
                        window: WindowId::new("window").unwrap(),
                        draft: DraftId::new(id).unwrap(),
                    },
                )
                .unwrap()
        }
        fn read(
            &self,
            record: &DocumentDraft,
            offset: u32,
            limit: u32,
        ) -> Result<DocumentDraftChunk, PluginError> {
            self.repo.read_document_draft(
                &self.project,
                &self.principal,
                ReadDocumentDraft {
                    window: record.window.clone(),
                    draft: record.draft.clone(),
                    expected_version: record.version,
                    offset,
                    limit,
                },
            )
        }
        fn discard(&mut self, record: &DocumentDraft) -> Result<DocumentDraft, PluginError> {
            self.repo.discard_document_draft(
                &self.project,
                &self.principal,
                DiscardDocumentDraft {
                    window: record.window.clone(),
                    draft: record.draft.clone(),
                    source: record.source.clone(),
                    expected_version: record.version,
                },
            )
        }
        fn chunk_count(&self) -> u32 {
            self.repo
                .connection
                .query_row("SELECT COUNT(*) FROM draft_chunks", [], |row| row.get(0))
                .unwrap()
        }
    }

    #[test]
    fn large_unicode_drafts_survive_reopen_with_bounded_version_pinned_reads() {
        let mut f = Fixture::new();
        let bytes = "草稿\r\n🙂\u{feff}".repeat(80_000).into_bytes();
        assert!(bytes.len() > 1024 * 1024);
        let args = f.stage("large", "first", &bytes, 100);
        assert!(f.inspect("large").is_none());
        let saved = f.save(args);
        assert_eq!(saved.version, 1);
        assert!(matches!(
            f.repo.remove(&f.source.revision),
            Err(PluginError::Referenced(_))
        ));
        let root = f.repo.root().to_path_buf();
        f.repo = PluginRepository::open(&root).unwrap();
        let mut restored = vec![];
        let mut offset = 0;
        loop {
            let page = f.read(&saved, offset, 63_999).unwrap();
            assert_eq!(page.digest, saved.content.digest);
            let part = STANDARD.decode(page.base64).unwrap();
            assert!(part.len() <= 63_999);
            restored.extend(part);
            match page.next {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(restored, bytes);
        let edge = f.read(&saved, 65_535, 7).unwrap();
        assert_eq!(STANDARD.decode(edge.base64).unwrap(), bytes[65_535..65_542]);
        let eof = f.read(&saved, bytes.len() as u32, 1).unwrap();
        assert_eq!(eof.base64, "");
        assert_eq!(eof.next, None);
        assert!(f.read(&saved, 0, 0).is_err());
        assert!(f.read(&saved, 0, 65_537).is_err());
        assert!(f.read(&saved, bytes.len() as u32 + 1, 1).is_err());
        assert_eq!(f.inspect("large"), Some(saved));
    }

    #[test]
    fn original_versions_conflict_and_concurrent_uploads_keep_separate_leases() {
        let mut f = Fixture::new();
        let a = f.stage("draft", "a", b"original", 100);
        let b = f.stage("draft", "b", b"original", 100);
        let saved = f.save(a);
        let mut changed = f.stage("draft", "c", b"later edit", 100);
        changed.expected_version = Some(saved.version);
        let latest = f.save(changed);
        assert_eq!(
            f.chunk_count(),
            2,
            "other capture still leases the original bytes"
        );
        assert!(matches!(
            f.repo
                .save_document_draft(&f.project, &f.principal, b.clone(), 100),
            Err(PluginError::Conflict)
        ));
        assert!(matches!(f.read(&saved, 0, 100), Err(PluginError::Conflict)));
        assert_eq!(f.inspect("draft").unwrap(), latest);
        let mut explicit = b;
        explicit.expected_version = Some(latest.version);
        let reverted = f.save(explicit);
        assert_eq!(
            STANDARD
                .decode(f.read(&reverted, 0, 100).unwrap().base64)
                .unwrap(),
            b"original"
        );
        assert_eq!(
            f.chunk_count(),
            1,
            "retired bytes without another lease are reclaimed immediately"
        );
    }

    #[test]
    fn scope_source_hash_size_and_metadata_are_validated_before_publication() {
        let mut f = Fixture::new();
        let args = f.stage("draft", "upload", b"contents", 100);
        for other in [ProjectId::new("other").unwrap()] {
            assert!(
                f.repo
                    .save_document_draft(&other, &f.principal, args.clone(), 100)
                    .is_err()
            );
        }
        assert!(
            f.repo
                .save_document_draft(
                    &f.project,
                    &PrincipalId::new("other").unwrap(),
                    args.clone(),
                    100
                )
                .is_err()
        );
        let mut wrong = args.clone();
        wrong.window = WindowId::new("other").unwrap();
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, wrong, 100)
                .is_err()
        );
        let mut wrong = args.clone();
        wrong.content.digest = content_digest(b"other");
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, wrong, 100)
                .is_err()
        );
        let mut wrong = args.clone();
        wrong.content.chunks[0].bytes -= 1;
        wrong.content.bytes -= 1;
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, wrong, 100)
                .is_err()
        );
        let mut wrong = args.clone();
        wrong.metadata = json!("x".repeat(MAX_DRAFT_METADATA_BYTES));
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, wrong, 100)
                .is_err()
        );
        let mut wrong = args.clone();
        wrong.source.contribution = ContributionId::new("missing").unwrap();
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, wrong, 100)
                .is_err()
        );
        let mut wrong = args.clone();
        wrong.source.revision = RevisionId::new(content_digest(b"missing").to_string()).unwrap();
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, wrong, 100)
                .is_err()
        );
        assert!(f.inspect("draft").is_none());
        assert!(f.repo.references(&f.source.revision).unwrap().is_empty());
        let saved = f.save(args);
        assert!(
            f.repo
                .document_draft(
                    &ProjectId::new("other").unwrap(),
                    &f.principal,
                    &DocumentDraftArguments {
                        window: saved.window.clone(),
                        draft: saved.draft.clone()
                    }
                )
                .unwrap()
                .is_none()
        );
        assert!(
            f.repo
                .read_document_draft(
                    &f.project,
                    &PrincipalId::new("other").unwrap(),
                    ReadDocumentDraft {
                        window: saved.window.clone(),
                        draft: saved.draft.clone(),
                        expected_version: saved.version,
                        offset: 0,
                        limit: 1
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn discard_fences_delayed_writes_releases_source_and_leaves_a_tombstone() {
        let mut f = Fixture::new();
        let create = f.stage("draft", "upload", b"original", 100);
        let saved = f.save(create.clone());
        let mut stale = saved.clone();
        stale.version = 0;
        assert!(matches!(f.discard(&stale), Err(PluginError::Conflict)));
        let mut wrong = saved.clone();
        wrong.source.contribution = ContributionId::new("other").unwrap();
        assert!(matches!(f.discard(&wrong), Err(PluginError::Conflict)));
        let _other_capture = f.stage("draft", "pending", b"pending upload", 100);
        let discarded = f.discard(&saved).unwrap();
        assert_eq!(discarded.version, 2);
        assert!(discarded.discarded);
        assert_eq!(discarded.content.bytes, 0);
        assert_eq!(f.chunk_count(), 0);
        assert!(matches!(
            f.repo
                .save_document_draft(&f.project, &f.principal, create, 100),
            Err(PluginError::Conflict)
        ));
        assert!(
            f.repo
                .stage_draft_chunk(
                    &f.project,
                    &f.principal,
                    StageDraftChunk {
                        window: saved.window.clone(),
                        draft: saved.draft.clone(),
                        upload: RequestId::new("late").unwrap(),
                        digest: content_digest(b"late"),
                        base64: STANDARD.encode(b"late")
                    },
                    100
                )
                .is_err()
        );
        assert!(f.read(&saved, 0, 1).is_err());
        assert!(f.read(&discarded, 0, 1).is_err());
        f.repo.remove(&f.source.revision).unwrap();
        assert_eq!(f.inspect("draft"), Some(discarded));
    }

    #[test]
    fn storage_faults_roll_back_content_version_leases_and_revision_references() {
        let mut f = Fixture::new();
        let create = f.stage("draft", "first", b"first", 100);
        f.repo.connection.execute_batch("CREATE TRIGGER fail_draft_ref BEFORE INSERT ON draft_chunk_refs BEGIN SELECT RAISE(FAIL,'draft ref failure'); END;").unwrap();
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, create.clone(), 100)
                .is_err()
        );
        assert!(f.inspect("draft").is_none());
        assert!(f.repo.references(&f.source.revision).unwrap().is_empty());
        f.repo
            .connection
            .execute_batch("DROP TRIGGER fail_draft_ref;")
            .unwrap();
        let saved = f.save(create);
        let mut changed = f.stage("draft", "second", b"second", 100);
        changed.expected_version = Some(saved.version);
        f.repo.connection.execute_batch("CREATE TRIGGER fail_draft_ref BEFORE INSERT ON draft_chunk_refs BEGIN SELECT RAISE(FAIL,'draft ref failure'); END;").unwrap();
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, changed.clone(), 100)
                .is_err()
        );
        assert_eq!(f.inspect("draft"), Some(saved.clone()));
        assert_eq!(
            STANDARD
                .decode(f.read(&saved, 0, 100).unwrap().base64)
                .unwrap(),
            b"first"
        );
        f.repo
            .connection
            .execute_batch("DROP TRIGGER fail_draft_ref;")
            .unwrap();
        let current = f.save(changed);
        assert_eq!(f.chunk_count(), 1);
        f.repo.connection.execute_batch("CREATE TRIGGER fail_discard BEFORE DELETE ON revision_refs WHEN OLD.owner_kind='document' BEGIN SELECT RAISE(FAIL,'discard failure'); END;").unwrap();
        assert!(f.discard(&current).is_err());
        assert_eq!(f.inspect("draft"), Some(current.clone()));
        assert_eq!(
            STANDARD
                .decode(f.read(&current, 0, 100).unwrap().base64)
                .unwrap(),
            b"second"
        );
        assert!(matches!(
            f.repo.remove(&f.source.revision),
            Err(PluginError::Referenced(_))
        ));
    }

    #[test]
    fn staging_expiry_is_write_only_and_cannot_collect_committed_content() {
        let mut f = Fixture::new();
        let saved_args = f.stage("saved", "save", b"saved", 100);
        let saved = f.save(saved_args);
        let orphan = f.stage("orphan", "abandoned", b"abandoned", 100);
        assert_eq!(f.chunk_count(), 2);
        assert!(f.inspect("orphan").is_none());
        f.read(&saved, 0, 1).unwrap();
        assert_eq!(f.chunk_count(), 2);
        let _new = f.stage("new", "new", b"new", STAGE_LIFETIME_MS + 100);
        assert_eq!(
            f.chunk_count(),
            2,
            "expired orphan is gone, committed bytes stay"
        );
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, orphan, STAGE_LIFETIME_MS + 100)
                .is_err()
        );
        assert_eq!(
            STANDARD
                .decode(f.read(&saved, 0, 100).unwrap().base64)
                .unwrap(),
            b"saved"
        );
        let bad = StageDraftChunk {
            window: saved.window.clone(),
            draft: DraftId::new("new").unwrap(),
            upload: RequestId::new("bad").unwrap(),
            digest: content_digest(b"wrong"),
            base64: STANDARD.encode(b"bytes"),
        };
        assert!(
            f.repo
                .stage_draft_chunk(&f.project, &f.principal, bad.clone(), 100)
                .is_err()
        );
        let mut bad = bad;
        bad.base64 = "A".repeat(MAX_DRAFT_CHUNK_BYTES as usize * 2);
        assert!(
            f.repo
                .stage_draft_chunk(&f.project, &f.principal, bad, 100)
                .is_err()
        );
    }

    #[test]
    fn count_quotas_bound_staging_and_drafts_without_dropping_acknowledged_state() {
        let mut f = Fixture::new();
        let empty = f.stage("empty", "upload", b"", 100);
        for index in 0..MAX_SCOPE_DRAFTS {
            let mut create = empty.clone();
            create.draft = DraftId::new(format!("draft-{index}")).unwrap();
            f.save(create);
        }
        assert!(
            f.repo
                .save_document_draft(&f.project, &f.principal, empty.clone(), 100)
                .is_err()
        );
        let old = f.inspect("draft-0").unwrap();
        f.discard(&old).unwrap();
        f.save(empty);
        assert!(f.inspect("draft-1").is_some());
        let stage = f.stage("staged", "original", b"same bytes", 100);
        f.repo.connection.execute("WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?)
            INSERT INTO draft_chunk_stages SELECT project,principal,window,draft,'upload-'||n,digest,expires
            FROM draft_chunk_stages CROSS JOIN numbers WHERE upload='original'", [MAX_SCOPE_STAGES - 1]).unwrap();
        let request = StageDraftChunk {
            window: stage.window.clone(),
            draft: stage.draft.clone(),
            upload: RequestId::new("original").unwrap(),
            digest: stage.content.digest,
            base64: STANDARD.encode(b"same bytes"),
        };
        assert!(
            f.repo
                .stage_draft_chunk(&f.project, &f.principal, request.clone(), 100)
                .is_ok(),
            "repeated staging retains its identity"
        );
        let mut excess = request.clone();
        excess.upload = RequestId::new("excess").unwrap();
        assert!(
            f.repo
                .stage_draft_chunk(&f.project, &f.principal, excess, 100)
                .is_err()
        );
        assert!(
            f.repo
                .stage_draft_chunk(&f.project, &f.principal, request, STAGE_LIFETIME_MS + 100)
                .is_ok()
        );
        assert!(f.inspect("draft-1").is_some());
    }

    #[test]
    fn chunk_corruption_is_an_error_on_read_and_cannot_be_hidden_by_reupload() {
        let mut f = Fixture::new();
        let args = f.stage("draft", "first", b"initial", 100);
        let saved = f.save(args);
        f.repo
            .connection
            .execute("UPDATE draft_chunks SET bytes=?", [b"changed".as_slice()])
            .unwrap();
        assert!(f.read(&saved, 0, 7).is_err());
        assert!(
            f.repo
                .stage_draft_chunk(
                    &f.project,
                    &f.principal,
                    StageDraftChunk {
                        window: saved.window.clone(),
                        draft: saved.draft.clone(),
                        upload: RequestId::new("repair").unwrap(),
                        digest: content_digest(b"initial"),
                        base64: STANDARD.encode(b"initial")
                    },
                    100
                )
                .is_err()
        );
        assert_eq!(f.inspect("draft"), Some(saved));
    }

    #[test]
    fn accepted_capture_survives_expiry_reopen_and_later_edits_until_original_settlement() {
        let mut f = Fixture::new();
        let args = f.stage("draft", "captured", b"accepted bytes", 100);
        let operation = OperationId::new("original/save:1").unwrap();
        f.repo
            .retain_draft_upload(&f.project, &f.principal, &operation, &args, 100)
            .unwrap();
        f.repo
            .retain_draft_upload(&f.project, &f.principal, &operation, &args, 100)
            .unwrap();
        assert!(matches!(
            f.repo.remove(&f.source.revision),
            Err(PluginError::Referenced(_))
        ));
        let mut other = args.clone();
        other.metadata = json!({"different":"capture"});
        assert!(
            f.repo
                .retain_draft_upload(&f.project, &f.principal, &operation, &other, 100)
                .is_err()
        );
        let root = f.repo.root().to_path_buf();
        f.repo = PluginRepository::open(&root).unwrap();
        let now = STAGE_LIFETIME_MS * 3;
        let saved = f
            .repo
            .save_document_draft(&f.project, &f.principal, args, now)
            .unwrap();
        let mut later = f.stage("draft", "later", b"later bytes", now);
        later.expected_version = Some(saved.version);
        let latest = f
            .repo
            .save_document_draft(&f.project, &f.principal, later, now)
            .unwrap();
        assert_eq!(
            f.chunk_count(),
            2,
            "accepted original still retains its own bytes after a successor save"
        );
        assert!(f.discard(&latest).is_err());
        f.repo
            .release_draft_upload(
                &f.project,
                &PrincipalId::new("other").unwrap(),
                &operation,
                now,
            )
            .unwrap();
        assert_eq!(
            f.chunk_count(),
            2,
            "another principal cannot release the original retention"
        );
        f.repo
            .release_draft_upload(&f.project, &f.principal, &operation, now)
            .unwrap();
        f.repo
            .release_draft_upload(&f.project, &f.principal, &operation, now)
            .unwrap();
        assert_eq!(f.chunk_count(), 1);
        assert_eq!(
            STANDARD
                .decode(f.read(&latest, 0, 100).unwrap().base64)
                .unwrap(),
            b"later bytes"
        );
        f.discard(&latest).unwrap();
        f.repo.remove(&f.source.revision).unwrap();
    }

    #[test]
    fn admission_and_settlement_retention_are_atomic_without_committing_a_draft() {
        let mut f = Fixture::new();
        let args = f.stage("draft", "captured", b"pending bytes", 100);
        let operation = OperationId::new("accepted").unwrap();
        f.repo.connection.execute_batch("CREATE TRIGGER fail_pin BEFORE INSERT ON revision_refs WHEN NEW.owner_kind='document' BEGIN SELECT RAISE(FAIL,'pin failure'); END;").unwrap();
        assert!(
            f.repo
                .retain_draft_upload(&f.project, &f.principal, &operation, &args, 100)
                .is_err()
        );
        let count: u32 = f
            .repo
            .connection
            .query_row("SELECT COUNT(*) FROM draft_upload_operations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(f.inspect("draft").is_none());
        f.repo
            .connection
            .execute_batch("DROP TRIGGER fail_pin;")
            .unwrap();
        f.repo
            .retain_draft_upload(&f.project, &f.principal, &operation, &args, 100)
            .unwrap();
        f.repo.connection.execute_batch("CREATE TRIGGER fail_unpin BEFORE DELETE ON revision_refs WHEN OLD.owner_kind='document' BEGIN SELECT RAISE(FAIL,'unpin failure'); END;").unwrap();
        assert!(
            f.repo
                .release_draft_upload(&f.project, &f.principal, &operation, STAGE_LIFETIME_MS * 2)
                .is_err()
        );
        assert!(f.inspect("draft").is_none());
        assert!(matches!(
            f.repo.remove(&f.source.revision),
            Err(PluginError::Referenced(_))
        ));
        f.repo
            .connection
            .execute_batch("DROP TRIGGER fail_unpin;")
            .unwrap();
        f.repo
            .release_draft_upload(&f.project, &f.principal, &operation, STAGE_LIFETIME_MS * 2)
            .unwrap();
        assert_eq!(f.chunk_count(), 0);
        assert!(f.inspect("draft").is_none());
        f.repo.remove(&f.source.revision).unwrap();
    }
}
