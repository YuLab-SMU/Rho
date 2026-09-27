//! Native evidence for ordinary R providers. This archive does not publish
//! results or decide visibility, pinning, deletion or reconciliation. Its caller
//! must qualify the original core Operation and retain the lease until settlement.
//! Graph restoration accepts neither a legacy Workspace manifest nor a caller's
//! arbitrary RDS path.
use crate::ArkRuntime;
use rho_plugin_protocol::{InstanceRef, PrincipalId, ProjectId};
use rho_r_api::{
    CheckpointArtifact, CheckpointCaptureArguments, CheckpointNativeRestoreReport, NativeError,
    OperationId,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

pub const MAX_RECOVERY_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub const MAX_RECOVERY_READ: u32 = 256 * 1024;
const MAX_METADATA: u64 = 1024 * 1024;
const FORMAT: u32 = 1;

/// Native scope supplied by initialization or a qualified original Operation,
/// never by an unqualified checkpoint request. References are not credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryScope {
    pub project: ProjectId,
    pub project_root: PathBuf,
    pub principal: PrincipalId,
    pub provider: InstanceRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoverySource {
    pub scope: RecoveryScope,
    pub operation_id: OperationId,
}

/// A complete native payload is still only evidence. A successful core result
/// or an explicit reconciliation must establish its scientific availability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryCapture {
    pub schema_version: u32,
    pub operation_id: OperationId,
    pub native_session_id: String,
    pub source: Option<RecoverySource>,
    pub artifact: CheckpointArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryControl {
    Pin { pinned: bool },
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryControlEvidence {
    pub schema_version: u32,
    pub operation_id: OperationId,
    pub checkpoint_id: OperationId,
    pub control: RecoveryControl,
}

#[derive(Clone)]
pub struct RecoveryArchive {
    root: PathBuf,
    scope: RecoveryScope,
    identity: FileIdentity,
}

/// An OS file lock coordinates different ordinary backend processes. Lock files
/// are permanent inode identities; closing the descriptor releases ownership.
/// A dead process therefore cannot leave a stale ownership marker to override.
pub struct RecoveryLease {
    archive: RecoveryArchive,
    operation: OperationId,
    directory: PathBuf,
    identity: FileIdentity,
    lock: File,
}

impl RecoveryArchive {
    /// Explicit storage preparation for capture/adoption. Does not launch R.
    pub fn create(data_root: &Path, scope: RecoveryScope) -> Result<Self, String> {
        normalized_directory(data_root)?;
        normalized_directory(&scope.project_root)?;
        let root = data_root.join("r-recovery-v1");
        match fs::create_dir(&root) {
            Ok(()) => {
                private_directory(&root)?;
                write_immutable(&root.join("scope.json"), &(FORMAT, &scope))?;
                sync_directory(data_root)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(error(e)),
        }
        Self::open(data_root, scope)?.ok_or_else(|| "Recovery archive disappeared".into())
    }

    /// Pure lookup. Missing archives stay missing; no R, lock or directory is created.
    pub fn open(data_root: &Path, scope: RecoveryScope) -> Result<Option<Self>, String> {
        normalized_directory(data_root)?;
        normalized_directory(&scope.project_root)?;
        let root = data_root.join("r-recovery-v1");
        match fs::symlink_metadata(&root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(error(e)),
            Ok(_) => {}
        }
        normalized_directory(&root)?;
        let (version, recorded): (u32, RecoveryScope) = read_json(&root.join("scope.json"))?;
        if version != FORMAT || recorded != scope {
            return Err(
                "Recovery archive scope or format differs from the original operation".into(),
            );
        }
        let identity = FileIdentity::of(&fs::metadata(&root).map_err(error)?);
        Ok(Some(Self {
            root,
            scope,
            identity,
        }))
    }

    pub fn scope(&self) -> &RecoveryScope {
        &self.scope
    }

    fn check(&self) -> Result<(), String> {
        normalized_directory(&self.root)?;
        if FileIdentity::of(&fs::metadata(&self.root).map_err(error)?) != self.identity {
            return Err("Recovery archive directory was replaced".into());
        }
        let (version, scope): (u32, RecoveryScope) = read_json(&self.root.join("scope.json"))?;
        if version != FORMAT || scope != self.scope {
            return Err("Recovery archive scope changed".into());
        }
        Ok(())
    }

    fn directory(&self, id: &OperationId) -> PathBuf {
        self.root.join(key(id))
    }

    fn begin(&self, operation: &OperationId) -> Result<RecoveryLease, String> {
        self.check()?;
        let directory = self.directory(operation);
        fs::create_dir(&directory).map_err(error)?; // Never reuse an original attempt.
        private_directory(&directory)?;
        let lock = create_file(&directory.join("lease"))?;
        lock.sync_all().map_err(error)?;
        sync_directory(&directory)?;
        sync_directory(&self.root)?;
        self.acquire(operation)
    }

    /// Exact native identity only; no directory scan or legacy-format discovery.
    /// Contention is returned immediately rather than blocking the RPC reader.
    pub fn acquire(&self, operation: &OperationId) -> Result<RecoveryLease, String> {
        self.check()?;
        let directory = self.directory(operation);
        normalized_directory(&directory)?;
        let path = directory.join("lease");
        let lock = checked_file(&path, true)?;
        if lock.metadata().map_err(error)?.len() != 0 {
            return Err("Recovery ownership lock has unexpected content".into());
        }
        lock.try_lock()
            .map_err(|e| format!("Recovery artifact is busy or unavailable: {e}"))?;
        let lease = RecoveryLease {
            archive: self.clone(),
            operation: operation.clone(),
            identity: FileIdentity::of(&fs::metadata(&directory).map_err(error)?),
            directory,
            lock,
        };
        lease.check()?;
        Ok(lease)
    }

    /// Reconciliation copies verified bytes into a new operation-owned identity.
    /// Deleting either copy can never remove the other copy's payload.
    /// This performs streaming filesystem work; async owners use a blocking worker.
    pub fn adopt(
        &self,
        operation: &OperationId,
        source: &RecoveryLease,
    ) -> Result<RecoveryLease, String> {
        if self.scope.project != source.archive.scope.project
            || self.scope.project_root != source.archive.scope.project_root
            || self.scope.principal != source.archive.scope.principal
        {
            return Err("Recovery adoption cannot change project or principal".into());
        }
        let capture = source.verify()?;
        let lease = self.begin(operation)?;
        let mut input = checked_file(&source.directory.join("payload.rds"), false)?;
        let mut output = create_file(&lease.directory.join("payload.staging"))?;
        let copied = std::io::copy(
            &mut (&mut input).take(capture.artifact.byte_size + 1),
            &mut output,
        )
        .map_err(error)?;
        if copied != capture.artifact.byte_size {
            return Err("Original recovery payload length changed during adoption".into());
        }
        output.sync_all().map_err(error)?;
        source.check()?;
        if digest(
            &lease.directory.join("payload.staging"),
            capture.artifact.byte_size,
        )? != (capture.artifact.sha256.clone(), capture.artifact.byte_size)
        {
            return Err("Original recovery payload changed during adoption; incomplete staging bytes were retained".into());
        }
        let adopted = lease.finish(
            capture.native_session_id,
            Some(RecoverySource {
                scope: source.archive.scope.clone(),
                operation_id: source.operation.clone(),
            }),
            capture.artifact.report.clone(),
            capture.artifact.byte_size,
        )?;
        if adopted.artifact != capture.artifact {
            return Err("Original recovery payload changed during adoption; the new evidence is unconfirmed".into());
        }
        Ok(lease)
    }
}

impl ArkRuntime {
    /// The ordinary owner supplies its original scope and keeps the returned
    /// lease through core settlement. This method never writes a result journal.
    pub async fn capture_recovery(
        &self,
        archive: &RecoveryArchive,
        operation: &OperationId,
        args: &CheckpointCaptureArguments,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Arc<RecoveryLease>, NativeError> {
        args.validate().map_err(NativeError::before_effect)?;
        if !self.checkpoint_ready
            || args.expected_session != self.session_id
            || archive.scope.project_root != Path::new(&self.project_root)
        {
            return Err(NativeError::before_effect(
                "Recovery native component, session or project differs",
            ));
        }
        if *cancel.borrow() {
            let mut error =
                NativeError::before_effect("Checkpoint capture cancelled before native work");
            error.query_code = Some("checkpoint_cancelled".into());
            return Err(error);
        }
        let lease = Arc::new(
            archive
                .begin(operation)
                .map_err(NativeError::before_effect)?,
        );
        let report = self
            .capture_native_graph(
                operation,
                &lease.directory.join("payload.staging"),
                args,
                cancel,
            )
            .await
            .map_err(|error| capture_failure(&lease, &self.session_id, error))?;
        let retained = lease.clone();
        let session = self.session_id.clone();
        let limit = args.max_bytes;
        let result =
            tokio::task::spawn_blocking(move || retained.finish(session, None, report, limit))
                .await;
        result
            .map_err(|e| capture_error(operation, &self.session_id, e))?
            .map_err(|e| capture_error(operation, &self.session_id, e))?;
        Ok(lease)
    }

    /// Accept only a locked native identity, never an arbitrary RDS path. The R
    /// bridge additionally checks an empty candidate, its installation, libraries,
    /// inventory and conservative graph. Failure may include namespace effects.
    pub async fn restore_recovery(
        &self,
        operation: &OperationId,
        source: Arc<RecoveryLease>,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CheckpointNativeRestoreReport, NativeError> {
        if !self.checkpoint_ready
            || source.archive.scope.project_root != Path::new(&self.project_root)
        {
            return Err(NativeError::before_effect(
                "Recovery component or candidate project differs",
            ));
        }
        if *cancel.borrow() {
            let mut error =
                NativeError::before_effect("Checkpoint restore cancelled before native work");
            error.query_code = Some("checkpoint_cancelled".into());
            return Err(error);
        }
        let verifying = source.clone();
        let capture = tokio::task::spawn_blocking(move || verifying.verify())
            .await
            .map_err(|e| NativeError::before_effect(e.to_string()))?
            .map_err(NativeError::before_effect)?;
        source.check().map_err(NativeError::before_effect)?;
        self.restore_native_graph(
            operation,
            &source.directory.join("payload.rds"),
            &capture.artifact.report,
            cancel,
        )
        .await
    }
}

fn capture_error(operation: &OperationId, session: &str, e: impl std::fmt::Display) -> NativeError {
    NativeError::after_possible_effect(
        format!("Native capture returned, but recovery retention is incomplete: {e}"),
        Some(serde_json::json!({
            "operation_id": operation, "session_id": session, "action": "inspect_original_recovery_evidence", "automatic_reexecution": false,
        })),
    )
}

fn capture_failure(lease: &RecoveryLease, session: &str, mut error: NativeError) -> NativeError {
    // A failed/malformed native response can still leave partially written graph
    // bytes. Preserve them and the original failure; never call them no effect.
    match fs::symlink_metadata(lease.directory.join("payload.staging")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => error.effect_may_have_occurred = true,
    }
    error.recovery.get_or_insert_with(|| {
        serde_json::json!({
            "operation_id": lease.operation, "session_id": session,
            "action": "inspect_original_recovery_evidence", "automatic_reexecution": false,
        })
    });
    error
}

impl RecoveryLease {
    pub fn operation_id(&self) -> &OperationId {
        &self.operation
    }
    pub fn scope(&self) -> &RecoveryScope {
        &self.archive.scope
    }
    pub fn check(&self) -> Result<(), String> {
        self.archive.check()?;
        normalized_directory(&self.directory)?;
        if FileIdentity::of(&fs::metadata(&self.directory).map_err(error)?) != self.identity {
            return Err("Recovery artifact directory was replaced".into());
        }
        let current = checked_file(&self.directory.join("lease"), false)?;
        let owned = self.lock.metadata().map_err(error)?;
        if FileIdentity::of(&current.metadata().map_err(error)?) != FileIdentity::of(&owned)
            || owned.len() != 0
        {
            return Err("Recovery artifact ownership lock was replaced or changed".into());
        }
        Ok(())
    }

    /// Read bounded native evidence without interpreting it as a committed result.
    pub fn capture(&self) -> Result<RecoveryCapture, String> {
        self.check()?;
        let capture: RecoveryCapture = read_json(&self.directory.join("capture.json"))?;
        if capture.schema_version != FORMAT
            || capture.operation_id != self.operation
            || capture.native_session_id.is_empty()
            || capture.native_session_id.len() > 160
            || capture.native_session_id.contains('\0')
            || capture.artifact.byte_size == 0
            || capture.artifact.byte_size > MAX_RECOVERY_BYTES
            || !valid_digest(&capture.artifact.sha256)
            || capture.source.as_ref().is_some_and(|source| {
                source.scope.project != self.archive.scope.project
                    || source.scope.project_root != self.archive.scope.project_root
                    || source.scope.principal != self.archive.scope.principal
            })
        {
            return Err("Recovery capture evidence has invalid identity, scope or bounds".into());
        }
        Ok(capture)
    }

    pub fn verify(&self) -> Result<RecoveryCapture, String> {
        let capture = self.capture()?;
        let actual = digest(
            &self.directory.join("payload.rds"),
            capture.artifact.byte_size,
        )?;
        if actual != (capture.artifact.sha256.clone(), capture.artifact.byte_size) {
            return Err("Recovery payload integrity differs".into());
        }
        self.check()?;
        Ok(capture)
    }

    /// Bounded, lock-qualified transport. The complete digest in capture metadata
    /// remains the caller's end-to-end integrity check; a chunk is not a result.
    pub fn read(&self, offset: u64, limit: u32) -> Result<Vec<u8>, String> {
        let capture = self.capture()?;
        if limit == 0 || limit > MAX_RECOVERY_READ || offset > capture.artifact.byte_size {
            return Err("Recovery read is outside its byte bounds".into());
        }
        let mut file = checked_file(&self.directory.join("payload.rds"), false)?;
        if file.metadata().map_err(error)?.len() != capture.artifact.byte_size {
            return Err("Recovery payload length differs".into());
        }
        file.seek(SeekFrom::Start(offset)).map_err(error)?;
        let mut bytes = vec![0; u64::from(limit).min(capture.artifact.byte_size - offset) as usize];
        file.read_exact(&mut bytes).map_err(error)?;
        self.check()?;
        Ok(bytes)
    }

    pub fn control(&self, operation: &OperationId) -> Result<RecoveryControlEvidence, String> {
        self.check()?;
        let evidence: RecoveryControlEvidence = read_json(
            &self
                .directory
                .join(format!("{}.control.json", key(operation))),
        )?;
        if evidence.schema_version != FORMAT
            || evidence.operation_id != *operation
            || evidence.checkpoint_id != self.operation
        {
            return Err("Recovery control evidence has different identities".into());
        }
        Ok(evidence)
    }

    pub fn record_control(
        &self,
        operation: &OperationId,
        control: RecoveryControl,
    ) -> Result<(), String> {
        self.capture()?;
        if operation == &self.operation {
            return Err("A control must retain its own original operation identity".into());
        }
        write_immutable(
            &self
                .directory
                .join(format!("{}.control.json", key(operation))),
            &RecoveryControlEvidence {
                schema_version: FORMAT,
                operation_id: operation.clone(),
                checkpoint_id: self.operation.clone(),
                control,
            },
        )
    }

    /// The caller must first observe a succeeded original deletion in the core
    /// journal. Native control evidence alone never authorizes this method.
    /// Failure is returned and all metadata remains; an absent payload is idempotent.
    pub fn remove_payload_after_commit(&self, deletion: &OperationId) -> Result<(), String> {
        if self.control(deletion)?.control != RecoveryControl::Delete {
            return Err("The original control is not a recovery deletion".into());
        }
        let path = self.directory.join("payload.rds");
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(error(e)),
            Ok(_) => {
                checked_file(&path, false)?;
            }
        }
        self.check()?;
        fs::remove_file(path).map_err(error)?;
        sync_directory(&self.directory)
    }

    fn finish(
        &self,
        session: String,
        source: Option<RecoverySource>,
        report: rho_r_api::CheckpointNativeReport,
        limit: u64,
    ) -> Result<RecoveryCapture, String> {
        self.check()?;
        if limit == 0 || limit > MAX_RECOVERY_BYTES {
            return Err("Recovery payload bound must be 1–17179869184 bytes".into());
        }
        let staging = self.directory.join("payload.staging");
        checked_file(&staging, false)?.sync_all().map_err(error)?;
        let (sha256, byte_size) = digest(&staging, limit)?;
        let path = self.directory.join("payload.rds");
        if fs::symlink_metadata(&path).is_ok() {
            return Err("Immutable recovery payload already exists".into());
        }
        fs::rename(&staging, &path).map_err(error)?;
        sync_directory(&self.directory)?;
        let capture = RecoveryCapture {
            schema_version: FORMAT,
            operation_id: self.operation.clone(),
            native_session_id: session,
            source,
            artifact: CheckpointArtifact {
                report,
                sha256,
                byte_size,
            },
        };
        write_immutable(&self.directory.join("capture.json"), &capture)?;
        self.capture()
    }
}

impl Drop for RecoveryLease {
    fn drop(&mut self) {
        if let Err(e) = self.lock.unlock() {
            eprintln!("R recovery artifact unlock failed: {e}");
        }
    }
}

fn key(id: &OperationId) -> String {
    format!("{:x}", Sha256::digest(id.as_str().as_bytes()))
}
fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn normalized_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || !fs::symlink_metadata(path).map_err(error)?.is_dir()
        || path.canonicalize().map_err(error)? != path
    {
        return Err("Recovery storage must use existing absolute normalized directories".into());
    }
    Ok(())
}
fn valid_file(metadata: &Metadata) -> Result<(), String> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Recovery evidence must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("Recovery evidence cannot be a hard link".into());
        }
    }
    Ok(())
}
fn checked_file(path: &Path, writable: bool) -> Result<File, String> {
    let before = fs::symlink_metadata(path).map_err(error)?;
    valid_file(&before)?;
    if path.canonicalize().map_err(error)? != path {
        return Err("Recovery file path is not normalized".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(writable)
        .open(path)
        .map_err(error)?;
    let opened = file.metadata().map_err(error)?;
    valid_file(&opened)?;
    if FileIdentity::of(&before) != FileIdentity::of(&opened) {
        return Err("Recovery evidence was replaced while opening".into());
    }
    Ok(file)
}
fn create_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(error)
}
fn private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    Ok(())
}
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(error)
}
fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let mut bytes = Vec::new();
    checked_file(path, false)?
        .take(MAX_METADATA + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err("Recovery metadata exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(error)
}
fn write_immutable(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(error)?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err("Recovery metadata exceeds 1 MiB".into());
    }
    if fs::symlink_metadata(path).is_ok() {
        return Err("Immutable recovery evidence already exists".into());
    }
    let staging = path.with_extension("staging");
    let mut file = create_file(&staging)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(error)?;
    fs::rename(&staging, path).map_err(error)?;
    sync_directory(path.parent().ok_or("Recovery metadata has no parent")?)
}
fn digest(path: &Path, limit: u64) -> Result<(String, u64), String> {
    let mut file = checked_file(path, false)?;
    let size = file.metadata().map_err(error)?.len();
    if size == 0 || size > limit {
        return Err("Recovery payload exceeds its declared byte bound or is empty".into());
    }
    let mut sha = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut reader = (&mut file).take(limit + 1);
    let mut bytes = 0;
    loop {
        let count = reader.read(&mut buffer).map_err(error)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > limit {
            return Err("Recovery payload grew beyond its declared byte bound".into());
        }
        sha.update(&buffer[..count]);
    }
    if bytes != size || file.metadata().map_err(error)?.len() != size {
        return Err("Recovery payload length changed while reading".into());
    }
    Ok((format!("sha256:{:x}", sha.finalize()), bytes))
}
#[derive(Clone, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    created: Option<std::time::SystemTime>,
}
impl FileIdentity {
    fn of(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                created: metadata.created().ok(),
            }
        }
    }
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests;
