//! Immutable, instance-owned bytes. Retention is not a scientific result commit.
use crate::{PluginError, PluginResourceVerifier, content_digest, ensure};
use async_trait::async_trait;
use rho_plugin_protocol::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct ResourceLimits {
    pub bytes: u64,
    pub instance_bytes: u64,
    pub total_bytes: u64,
    pub count: u64,
}
impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            bytes: MAX_RESOURCE_BYTES,
            instance_bytes: 512 * 1024 * 1024,
            total_bytes: 2 * 1024 * 1024 * 1024,
            count: 16384,
        }
    }
}

#[derive(Clone)]
pub struct PluginResources {
    connection: Arc<Mutex<Connection>>,
    limits: ResourceLimits,
    /// Bound staging disk use independently of eventual committed-store quotas.
    pub(crate) transfers: Arc<tokio::sync::Semaphore>,
}
impl PluginResources {
    pub fn open(root: &Path) -> Result<Self, PluginError> {
        Self::open_with_limits(root, ResourceLimits::default())
    }
    pub fn open_with_limits(root: &Path, limits: ResourceLimits) -> Result<Self, PluginError> {
        ensure(
            limits.bytes <= MAX_RESOURCE_BYTES,
            "resource policy exceeds protocol limit",
        )?;
        let path = root.join("resources-v1.sqlite3");
        if path.try_exists()? {
            let existing = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let version: u32 =
                existing.query_row("SELECT version FROM resource_schema", [], |r| r.get(0))?;
            ensure(version == 1, "unsupported resource store version")?;
        }
        std::fs::create_dir_all(root)?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS resource_schema(version INTEGER PRIMARY KEY CHECK(version=1));
            INSERT OR IGNORE INTO resource_schema VALUES(1);
            CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, project TEXT NOT NULL, principal TEXT NOT NULL, instance TEXT NOT NULL, owner TEXT NOT NULL, bytes INTEGER NOT NULL, reference TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS resources_owner ON resources(project,principal,instance);
            CREATE TABLE IF NOT EXISTS resource_chunks(resource TEXT NOT NULL REFERENCES resources(id), ordinal INTEGER NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(resource,ordinal));")?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            limits,
            transfers: Arc::new(tokio::sync::Semaphore::new(4)),
        })
    }
    pub(crate) fn declaration(&self, declaration: &ResourceDeclaration) -> Result<(), PluginError> {
        declaration.validate()?;
        ensure(
            declaration.bytes <= self.limits.bytes,
            "resource exceeds configured byte quota",
        )
    }
    /// The native transport supplies this authority from its active request map.
    /// No owner, project, principal or local path is taken from the upload header.
    pub fn retain(
        &self,
        call: &PluginCall,
        declaration: &ResourceDeclaration,
        mut input: impl Read,
    ) -> Result<ResourceReference, PluginError> {
        self.declaration(declaration)?;
        let id = ResourceId::new(format!(
            "resource-{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &call.binding.provider,
                &call.binding.project,
                &call.principal,
                declaration,
            ))?)
        ))?;
        let reference = ResourceReference {
            owner: call.binding.provider.clone(),
            resource: id,
            digest: declaration.digest.clone(),
            media_type: declaration.media_type.clone(),
            bytes: declaration.bytes,
        };
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT reference FROM resources WHERE id=?",
                [reference.resource.as_str()],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(existing) = &existing {
            ensure(
                serde_json::from_str::<ResourceReference>(existing)? == reference,
                "immutable resource collision",
            )?;
        } else {
            let (count, total): (u64, u64) = tx.query_row(
                "SELECT count(*),coalesce(sum(bytes),0) FROM resources",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let instance: u64 = tx.query_row("SELECT coalesce(sum(bytes),0) FROM resources WHERE project=? AND principal=? AND instance=?", params![call.binding.project.as_str(),call.principal.as_str(),call.binding.provider.instance.as_str()], |r| r.get(0))?;
            ensure(
                count < self.limits.count
                    && declaration.bytes <= self.limits.total_bytes.saturating_sub(total)
                    && declaration.bytes <= self.limits.instance_bytes.saturating_sub(instance),
                "resource retention quota reached; existing resources were preserved",
            )?;
            tx.execute(
                "INSERT INTO resources VALUES(?,?,?,?,?,?,?)",
                params![
                    reference.resource.as_str(),
                    call.binding.project.as_str(),
                    call.principal.as_str(),
                    call.binding.provider.instance.as_str(),
                    serde_json::to_string(&call.binding.provider)?,
                    reference.bytes,
                    serde_json::to_string(&reference)?
                ],
            )?;
        }
        let mut remaining = declaration.bytes;
        let mut ordinal = 0_u64;
        let mut digest = Sha256::new();
        let mut buffer = [0; CHUNK_BYTES];
        while remaining > 0 {
            let size = remaining.min(CHUNK_BYTES as u64) as usize;
            input.read_exact(&mut buffer[..size])?;
            let bytes = &buffer[..size];
            digest.update(bytes);
            if existing.is_none() {
                tx.execute(
                    "INSERT INTO resource_chunks VALUES(?,?,?,?)",
                    params![
                        reference.resource.as_str(),
                        ordinal,
                        content_digest(bytes).as_str(),
                        bytes
                    ],
                )?;
            }
            remaining -= size as u64;
            ordinal += 1;
        }
        ensure(
            input.read(&mut buffer[..1])? == 0,
            "resource has trailing bytes",
        )?;
        ensure(
            format!("sha256:{:x}", digest.finalize()) == declaration.digest.as_str(),
            "resource digest differs from received bytes",
        )?;
        // Duplicated uploads never overwrite a damaged or different retained object.
        if existing.is_some() {
            verify_bytes(&tx, &reference)?;
        }
        tx.commit()?;
        Ok(reference)
    }
    pub fn list(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: &ResourceList,
    ) -> Result<ResourcePage, PluginError> {
        ensure(
            args.limit > 0 && args.limit <= 100,
            "resource page limit must be 1–100",
        )?;
        let connection = self.connection.lock().unwrap();
        let owner = args.owner.as_ref().map(serde_json::to_string).transpose()?;
        let total: u64 = connection.query_row("SELECT count(*) FROM resources WHERE project=? AND principal=? AND (? IS NULL OR owner=?)", params![project.as_str(),principal.as_str(),owner,owner], |r| r.get(0))?;
        let mut stmt = connection.prepare("SELECT reference FROM resources WHERE project=? AND principal=? AND (? IS NULL OR owner=?) AND (? IS NULL OR id>?) ORDER BY id LIMIT ?")?;
        let after = args.after.as_ref().map(ResourceId::as_str);
        let rows = stmt.query_map(
            params![
                project.as_str(),
                principal.as_str(),
                owner,
                owner,
                after,
                after,
                u32::from(args.limit) + 1
            ],
            |r| r.get::<_, String>(0),
        )?;
        let mut items: Vec<ResourceReference> = rows
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<_, PluginError>>()?;
        let next = if items.len() > args.limit as usize {
            items.pop();
            items.last().map(|r| r.resource.clone())
        } else {
            None
        };
        Ok(ResourcePage { items, next, total })
    }
    pub(crate) fn qualify_reference(&self, project: &ProjectId, principal: &PrincipalId,
        reference: &ResourceReference) -> Result<(), PluginError> {
        qualify(&self.connection.lock().unwrap(), project, principal, reference)
    }
    pub fn inspect(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        reference: &ResourceReference,
    ) -> Result<ResourceReference, PluginError> {
        let connection = self.connection.lock().unwrap();
        qualify(&connection, project, principal, reference)?;
        verify_bytes(&connection, reference)?;
        Ok(reference.clone())
    }
    pub fn read(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        read: &ResourceRead,
    ) -> Result<Vec<u8>, PluginError> {
        read.validate()?;
        let connection = self.connection.lock().unwrap();
        qualify(&connection, project, principal, &read.reference)?;
        let end = read
            .reference
            .bytes
            .min(read.offset + u64::from(read.limit));
        let mut result = Vec::with_capacity((end - read.offset) as usize);
        if end == read.offset {
            return Ok(result);
        }
        for ordinal in (read.offset / CHUNK_BYTES as u64)..=((end - 1) / CHUNK_BYTES as u64) {
            let (digest, bytes): (String, Vec<u8>) = connection.query_row(
                "SELECT digest,bytes FROM resource_chunks WHERE resource=? AND ordinal=?",
                params![read.reference.resource.as_str(), ordinal],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let start = ordinal * CHUNK_BYTES as u64;
            ensure(
                bytes.len() == (read.reference.bytes - start).min(CHUNK_BYTES as u64) as usize
                    && content_digest(&bytes).as_str() == digest,
                "retained resource chunk is damaged",
            )?;
            result.extend_from_slice(
                &bytes[read.offset.saturating_sub(start) as usize
                    ..(end - start).min(bytes.len() as u64) as usize],
            );
        }
        Ok(result)
    }
}
fn qualify(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    reference: &ResourceReference,
) -> Result<(), PluginError> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT reference FROM resources WHERE id=? AND project=? AND principal=?",
            params![
                reference.resource.as_str(),
                project.as_str(),
                principal.as_str()
            ],
            |r| r.get(0),
        )
        .optional()?;
    let stored: ResourceReference = stored
        .ok_or_else(|| PluginError::Missing("resource".into()))
        .and_then(|s| Ok(serde_json::from_str(&s)?))?;
    ensure(
        stored == *reference,
        "resource reference differs from retained identity",
    )
}
fn verify_bytes(connection: &Connection, reference: &ResourceReference) -> Result<(), PluginError> {
    let mut stmt = connection.prepare(
        "SELECT ordinal,digest,bytes FROM resource_chunks WHERE resource=? ORDER BY ordinal",
    )?;
    let mut rows = stmt.query([reference.resource.as_str()])?;
    let mut offset = 0_u64;
    let mut hasher = Sha256::new();
    while let Some(row) = rows.next()? {
        let ordinal: u64 = row.get(0)?;
        let digest: String = row.get(1)?;
        let bytes: Vec<u8> = row.get(2)?;
        ensure(
            offset < reference.bytes
                && ordinal == offset / CHUNK_BYTES as u64
                && bytes.len() == (reference.bytes - offset).min(CHUNK_BYTES as u64) as usize
                && content_digest(&bytes).as_str() == digest,
            "retained resource chunks are damaged or incomplete",
        )?;
        offset += bytes.len() as u64;
        hasher.update(bytes);
    }
    ensure(
        offset == reference.bytes
            && format!("sha256:{:x}", hasher.finalize()) == reference.digest.as_str(),
        "retained resource digest mismatch",
    )
}
#[async_trait]
impl PluginResourceVerifier for PluginResources {
    async fn verify(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        reference: &ResourceReference,
    ) -> Result<(), String> {
        let store = self.clone();
        let project = project.clone();
        let principal = principal.clone();
        let reference = reference.clone();
        tokio::task::spawn_blocking(move || {
            store.inspect(&project, &principal, &reference).map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }
}
