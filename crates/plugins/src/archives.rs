//! Scoped package transfer bytes and original import/export receipts. No runtime,
//! filesystem path supplied by a caller, or scientific result is involved.
use crate::{PluginError, PluginRepository, content_digest, ensure, validate_archive};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use rusqlite::{Connection, OptionalExtension, params};

const LEASE_MS: u64 = 24 * 60 * 60 * 1000;
const SCOPE_BYTES: u64 = MAX_PLUGIN_ARCHIVE_BYTES * 2;
const TOTAL_BYTES: u64 = MAX_PLUGIN_ARCHIVE_BYTES * 8;

pub(crate) fn initialize(connection: &Connection) -> Result<(), PluginError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS plugin_archives(
        project TEXT NOT NULL, principal TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
        bytes INTEGER NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(project,principal,id));
        CREATE TABLE IF NOT EXISTS plugin_archive_chunks(
        project TEXT NOT NULL, principal TEXT NOT NULL, archive TEXT NOT NULL, offset INTEGER NOT NULL,
        bytes BLOB NOT NULL, PRIMARY KEY(project,principal,archive,offset),
        FOREIGN KEY(project,principal,archive) REFERENCES plugin_archives(project,principal,id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS plugin_archive_holds(
        project TEXT NOT NULL, principal TEXT NOT NULL, operation TEXT NOT NULL, archive TEXT NOT NULL,
        PRIMARY KEY(project,principal,operation),
        FOREIGN KEY(project,principal,archive) REFERENCES plugin_archives(project,principal,id));
        CREATE TABLE IF NOT EXISTS plugin_archive_receipts(
        project TEXT NOT NULL, principal TEXT NOT NULL, operation TEXT NOT NULL, intent TEXT NOT NULL,
        receipt TEXT NOT NULL, PRIMARY KEY(project,principal,operation));")?;
    Ok(())
}
fn reference(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    wanted: &PluginArchiveReference,
) -> Result<String, PluginError> {
    wanted.validate()?;
    let found: Option<(String, u64, String)> = connection.query_row("SELECT digest,bytes,origin FROM plugin_archives WHERE project=? AND principal=? AND id=?",
        params![project.as_str(),principal.as_str(),wanted.archive.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (digest, bytes, origin) =
        found.ok_or_else(|| PluginError::Missing(wanted.archive.to_string()))?;
    ensure(
        digest == wanted.digest.as_str() && bytes == wanted.bytes,
        "archive reference changed",
    )?;
    Ok(origin)
}
fn received(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    reference: &PluginArchiveReference,
) -> Result<u64, PluginError> {
    Ok(connection.query_row("SELECT coalesce(sum(length(bytes)),0) FROM plugin_archive_chunks WHERE project=? AND principal=? AND archive=?",
        params![project.as_str(),principal.as_str(),reference.archive.as_str()], |r| r.get(0))?)
}
fn collect(connection: &Connection, now: u64) -> Result<(), PluginError> {
    connection.execute("DELETE FROM plugin_archives AS a WHERE expires<=? AND NOT EXISTS(SELECT 1 FROM plugin_archive_holds h WHERE h.project=a.project AND h.principal=a.principal AND h.archive=a.id)", [now])?;
    Ok(())
}
fn reserve(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    reference: &PluginArchiveReference,
    origin: &str,
    now: u64,
) -> Result<(), PluginError> {
    reference.validate()?;
    let (count,bytes): (u64,u64) = connection.query_row("SELECT count(*),coalesce(sum(bytes),0) FROM plugin_archives WHERE project=? AND principal=?",params![project.as_str(),principal.as_str()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let (total_count, total): (u64, u64) = connection.query_row(
        "SELECT count(*),coalesce(sum(bytes),0) FROM plugin_archives",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    ensure(
        count < 16
            && total_count < 128
            && reference.bytes <= SCOPE_BYTES.saturating_sub(bytes)
            && reference.bytes <= TOTAL_BYTES.saturating_sub(total),
        "archive transfer quota reached; retained bytes were preserved",
    )?;
    connection.execute(
        "INSERT INTO plugin_archives VALUES(?,?,?,?,?,?,?)",
        params![
            project.as_str(),
            principal.as_str(),
            reference.archive.as_str(),
            reference.digest.as_str(),
            reference.bytes,
            origin,
            now.saturating_add(LEASE_MS)
        ],
    )?;
    Ok(())
}
fn receipt(reference: &PluginArchiveReference, archive: &PluginArchive) -> PluginArchiveReceipt {
    let mut artifacts = archive
        .artifacts
        .iter()
        .map(|value| value.id.clone())
        .collect::<Vec<_>>();
    artifacts.sort();
    PluginArchiveReceipt {
        reference: reference.clone(),
        revision: archive.revision.id.clone(),
        plugin: archive.revision.manifest.id.clone(),
        artifacts,
    }
}
fn original(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    operation: &OperationId,
    intent: &str,
) -> Result<Option<PluginArchiveReceipt>, PluginError> {
    let row: Option<(String,String)> = connection.query_row("SELECT intent,receipt FROM plugin_archive_receipts WHERE project=? AND principal=? AND operation=?",params![project.as_str(),principal.as_str(),operation.as_str()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(found, receipt)| {
        ensure(found == intent, "original archive intent changed")?;
        Ok(serde_json::from_str(&receipt)?)
    })
    .transpose()
}
fn record(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    operation: &OperationId,
    intent: &str,
    receipt: &PluginArchiveReceipt,
) -> Result<(), PluginError> {
    connection.execute(
        "INSERT INTO plugin_archive_receipts VALUES(?,?,?,?,?)",
        params![
            project.as_str(),
            principal.as_str(),
            operation.as_str(),
            intent,
            serde_json::to_string(receipt)?
        ],
    )?;
    Ok(())
}
impl PluginRepository {
    pub fn stage_archive(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: &StagePluginArchive,
        now: u64,
    ) -> Result<PluginArchiveProgress, PluginError> {
        args.reference.validate()?;
        ensure(
            args.offset < args.reference.bytes
                && args.offset.is_multiple_of(ARCHIVE_CHUNK_BYTES as u64)
                && args.base64.len() <= ARCHIVE_CHUNK_BYTES.div_ceil(3) * 4,
            "invalid archive chunk range",
        )?;
        let bytes = STANDARD
            .decode(&args.base64)
            .map_err(|_| PluginError::Invalid("invalid archive chunk encoding".into()))?;
        ensure(
            bytes.len() as u64
                == (args.reference.bytes - args.offset).min(ARCHIVE_CHUNK_BYTES as u64),
            "incomplete archive chunk",
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        collect(&transaction, now)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_archives WHERE project=? AND principal=? AND id=?)",
            params![
                project.as_str(),
                principal.as_str(),
                args.reference.archive.as_str()
            ],
            |r| r.get(0),
        )?;
        if exists {
            ensure(
                reference(&transaction, project, principal, &args.reference)? == "upload",
                "an export cannot be overwritten by an upload",
            )?;
        } else {
            reserve(
                &transaction,
                project,
                principal,
                &args.reference,
                "upload",
                now,
            )?;
        }
        let previous: Option<Vec<u8>> = transaction.query_row("SELECT bytes FROM plugin_archive_chunks WHERE project=? AND principal=? AND archive=? AND offset=?",params![project.as_str(),principal.as_str(),args.reference.archive.as_str(),args.offset],|r|r.get(0)).optional()?;
        if let Some(previous) = previous {
            ensure(previous == bytes, "staged archive chunk is immutable")?;
        } else {
            transaction.execute(
                "INSERT INTO plugin_archive_chunks VALUES(?,?,?,?,?)",
                params![
                    project.as_str(),
                    principal.as_str(),
                    args.reference.archive.as_str(),
                    args.offset,
                    bytes
                ],
            )?;
        }
        transaction.execute(
            "UPDATE plugin_archives SET expires=? WHERE project=? AND principal=? AND id=?",
            params![
                now.saturating_add(LEASE_MS),
                project.as_str(),
                principal.as_str(),
                args.reference.archive.as_str()
            ],
        )?;
        let received = received(&transaction, project, principal, &args.reference)?;
        transaction.commit()?;
        Ok(PluginArchiveProgress {
            reference: args.reference.clone(),
            received,
            complete: received == args.reference.bytes,
        })
    }
    /// Explicit cleanup never discards bytes held by an unresolved original.
    pub fn discard_archive(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        wanted: &PluginArchiveReference,
    ) -> Result<PluginArchiveDiscarded, PluginError> {
        wanted.validate()?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        match reference(&transaction, project, principal, wanted) {
            Ok(_) => (),
            Err(PluginError::Missing(_)) => {
                return Ok(PluginArchiveDiscarded {
                    reference: wanted.clone(),
                    discarded: true,
                });
            }
            Err(error) => return Err(error),
        }
        let held:bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM plugin_archive_holds WHERE project=? AND principal=? AND archive=?)",params![project.as_str(),principal.as_str(),wanted.archive.as_str()],|r|r.get(0))?;
        ensure(
            !held,
            "archive is retained by an unresolved original operation",
        )?;
        transaction.execute(
            "DELETE FROM plugin_archives WHERE project=? AND principal=? AND id=?",
            params![
                project.as_str(),
                principal.as_str(),
                wanted.archive.as_str()
            ],
        )?;
        transaction.commit()?;
        Ok(PluginArchiveDiscarded {
            reference: wanted.clone(),
            discarded: true,
        })
    }
    pub fn archive_progress(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        wanted: &PluginArchiveReference,
    ) -> Result<PluginArchiveProgress, PluginError> {
        let snapshot = self.connection.unchecked_transaction()?;
        reference(&self.connection, project, principal, wanted)?;
        let received = received(&self.connection, project, principal, wanted)?;
        snapshot.commit()?;
        Ok(PluginArchiveProgress {
            reference: wanted.clone(),
            received,
            complete: received == wanted.bytes,
        })
    }
    pub fn read_archive_chunk(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: &ReadPluginArchive,
    ) -> Result<PluginArchiveChunk, PluginError> {
        let snapshot = self.connection.unchecked_transaction()?;
        reference(&self.connection, project, principal, &args.reference)?;
        ensure(
            args.offset <= args.reference.bytes
                && args.limit > 0
                && args.limit as usize <= ARCHIVE_CHUNK_BYTES,
            "invalid archive read range",
        )?;
        let end = args
            .offset
            .saturating_add(args.limit.into())
            .min(args.reference.bytes);
        let mut offset = args.offset;
        let mut bytes = Vec::with_capacity((end - offset) as usize);
        while offset < end {
            let start = offset / ARCHIVE_CHUNK_BYTES as u64 * ARCHIVE_CHUNK_BYTES as u64;
            let part: Option<Vec<u8>> = self.connection.query_row("SELECT bytes FROM plugin_archive_chunks WHERE project=? AND principal=? AND archive=? AND offset=?",params![project.as_str(),principal.as_str(),args.reference.archive.as_str(),start],|r|r.get(0)).optional()?;
            let part = part
                .ok_or_else(|| PluginError::Missing("archive chunk has not been staged".into()))?;
            let local = (offset - start) as usize;
            let length = ((end - offset) as usize).min(part.len().saturating_sub(local));
            ensure(length > 0, "stored archive range is incomplete")?;
            bytes.extend_from_slice(&part[local..local + length]);
            offset += length as u64;
        }
        let chunk = PluginArchiveChunk {
            reference: args.reference.clone(),
            offset: args.offset,
            base64: STANDARD.encode(bytes),
            next: (end < args.reference.bytes).then_some(end),
        };
        snapshot.commit()?;
        Ok(chunk)
    }
    pub fn validated_archive(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        wanted: &PluginArchiveReference,
    ) -> Result<PluginArchive, PluginError> {
        let snapshot = self.connection.unchecked_transaction()?;
        reference(&self.connection, project, principal, wanted)?;
        ensure(
            received(&self.connection, project, principal, wanted)? == wanted.bytes,
            "archive upload is incomplete",
        )?;
        let mut bytes = Vec::with_capacity(wanted.bytes as usize);
        let mut query = self.connection.prepare("SELECT offset,bytes FROM plugin_archive_chunks WHERE project=? AND principal=? AND archive=? ORDER BY offset")?;
        let rows = query.query_map(
            params![
                project.as_str(),
                principal.as_str(),
                wanted.archive.as_str()
            ],
            |r| Ok((r.get::<_, u64>(0)?, r.get::<_, Vec<u8>>(1)?)),
        )?;
        for row in rows {
            let (offset, part) = row?;
            ensure(
                offset == bytes.len() as u64
                    && part.len() <= ARCHIVE_CHUNK_BYTES
                    && part.len() as u64 <= wanted.bytes.saturating_sub(offset),
                "stored archive ranges changed",
            )?;
            bytes.extend_from_slice(&part);
        }
        ensure(
            bytes.len() as u64 == wanted.bytes && content_digest(&bytes) == wanted.digest,
            "archive checksum mismatch",
        )?;
        let archive: PluginArchive = serde_json::from_slice(&bytes)
            .map_err(|_| PluginError::Invalid("archive is not valid package JSON".into()))?;
        validate_archive(&archive)?;
        drop(query);
        snapshot.commit()?;
        Ok(archive)
    }
    pub fn inspect_archive(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        wanted: &PluginArchiveReference,
    ) -> Result<PluginArchiveInspection, PluginError> {
        let archive = self.validated_archive(project, principal, wanted)?;
        Ok(PluginArchiveInspection {
            reference: wanted.clone(),
            revision: archive.revision.id.clone(),
            plugin: archive.revision.manifest.id.clone(),
            name: archive.revision.manifest.name.clone(),
            version: archive.revision.manifest.version.clone(),
            description: archive.revision.manifest.description.clone(),
            source_files: archive.revision.files.len() as u32,
            artifacts: archive
                .artifacts
                .iter()
                .map(|a| PluginArtifactSummary {
                    id: a.id.clone(),
                    target: a.target.clone(),
                    file_count: a.files.len() as u64,
                })
                .collect(),
        })
    }
    pub fn hold_archive(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        operation: &OperationId,
        wanted: &PluginArchiveReference,
    ) -> Result<(), PluginError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        reference(&transaction, project, principal, wanted)?;
        ensure(
            received(&transaction, project, principal, wanted)? == wanted.bytes,
            "accepted archive is incomplete",
        )?;
        let previous: Option<String> = transaction.query_row("SELECT archive FROM plugin_archive_holds WHERE project=? AND principal=? AND operation=?",params![project.as_str(),principal.as_str(),operation.as_str()],|r|r.get(0)).optional()?;
        if let Some(previous) = previous {
            ensure(
                previous == wanted.archive.as_str(),
                "original archive capture changed",
            )?;
        } else {
            transaction.execute(
                "INSERT INTO plugin_archive_holds VALUES(?,?,?,?)",
                params![
                    project.as_str(),
                    principal.as_str(),
                    operation.as_str(),
                    wanted.archive.as_str()
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
    pub fn release_archive(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        operation: &OperationId,
        now: u64,
    ) -> Result<(), PluginError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        transaction.execute("UPDATE plugin_archives SET expires=? WHERE project=? AND principal=? AND id IN(SELECT archive FROM plugin_archive_holds WHERE project=? AND principal=? AND operation=?)",params![now.saturating_add(LEASE_MS),project.as_str(),principal.as_str(),project.as_str(),principal.as_str(),operation.as_str()])?;
        transaction.execute(
            "DELETE FROM plugin_archive_holds WHERE project=? AND principal=? AND operation=?",
            params![project.as_str(), principal.as_str(), operation.as_str()],
        )?;
        transaction.commit()?;
        Ok(())
    }
    pub fn import_archive_operation(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        operation: &OperationId,
        wanted: &PluginArchiveReference,
    ) -> Result<PluginArchiveReceipt, PluginError> {
        let intent = serde_json::to_string(&("import", wanted))?;
        if let Some(prior) = original(&self.connection, project, principal, operation, &intent)? {
            return Ok(prior);
        }
        let archive = self.validated_archive(project, principal, wanted)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(prior) = original(&transaction, project, principal, operation, &intent)? {
            return Ok(prior);
        }
        let held: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM plugin_archive_holds WHERE project=? AND principal=? AND operation=? AND archive=?)",params![project.as_str(),principal.as_str(),operation.as_str(),wanted.archive.as_str()],|r|r.get(0))?;
        ensure(
            held,
            "import requires its original accepted archive capture",
        )?;
        crate::repository::store_archive(&transaction, &archive)?;
        transaction.execute(
            "INSERT OR IGNORE INTO revision_refs VALUES('archive_import',?,?)",
            params![operation.as_str(), archive.revision.id.as_str()],
        )?;
        let receipt = receipt(wanted, &archive);
        record(
            &transaction,
            project,
            principal,
            operation,
            &intent,
            &receipt,
        )?;
        transaction.commit()?;
        Ok(receipt)
    }
    pub fn export_archive_operation(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        operation: &OperationId,
        args: &ExportPluginArchive,
        now: u64,
    ) -> Result<PluginArchiveReceipt, PluginError> {
        args.validate()?;
        let intent = serde_json::to_string(&("export", args))?;
        if let Some(prior) = original(&self.connection, project, principal, operation, &intent)? {
            return Ok(prior);
        }
        let snapshot = self.connection.unchecked_transaction()?;
        let archive = self.export_selection(args)?;
        snapshot.commit()?;
        let bytes = serde_json::to_vec(&archive)?;
        let wanted = PluginArchiveReference {
            archive: ArchiveId::new(format!(
                "archive-{}",
                &content_digest(operation.as_str().as_bytes()).as_str()[7..]
            ))?,
            digest: content_digest(&bytes),
            bytes: bytes.len() as u64,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(prior) = original(&transaction, project, principal, operation, &intent)? {
            return Ok(prior);
        }
        collect(&transaction, now)?;
        reserve(&transaction, project, principal, &wanted, "export", now)?;
        for (index, part) in bytes.chunks(ARCHIVE_CHUNK_BYTES).enumerate() {
            transaction.execute(
                "INSERT INTO plugin_archive_chunks VALUES(?,?,?,?,?)",
                params![
                    project.as_str(),
                    principal.as_str(),
                    wanted.archive.as_str(),
                    index * ARCHIVE_CHUNK_BYTES,
                    part
                ],
            )?;
        }
        transaction.execute(
            "INSERT INTO plugin_archive_holds VALUES(?,?,?,?)",
            params![
                project.as_str(),
                principal.as_str(),
                operation.as_str(),
                wanted.archive.as_str()
            ],
        )?;
        let receipt = receipt(&wanted, &archive);
        record(
            &transaction,
            project,
            principal,
            operation,
            &intent,
            &receipt,
        )?;
        transaction.commit()?;
        Ok(receipt)
    }
    /// The receipt proves this original catalog transaction; the Operation
    /// journal remains authoritative about settlement and uncertain outcomes.
    pub fn archive_operation_receipt(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        operation: &OperationId,
    ) -> Result<Option<PluginArchiveReceipt>, PluginError> {
        let value: Option<String> = self.connection.query_row("SELECT receipt FROM plugin_archive_receipts WHERE project=? AND principal=? AND operation=?",params![project.as_str(),principal.as_str(),operation.as_str()],|r|r.get(0)).optional()?;
        value
            .map(|v| serde_json::from_str(&v).map_err(PluginError::from))
            .transpose()
    }
}
