//! Native immutable checkpoint artifacts. Files are evidence; the Workspace journal
//! decides publication, visibility, pinning and deletion.
use super::*;
use rho_r_api::*;
use rho_r_api::{CheckpointArtifact, CheckpointControlEvidence};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
};

#[derive(Clone)]
pub(super) struct CheckpointStore {
    root: PathBuf,
}
impl CheckpointStore {
    pub(super) async fn artifact_lease(
        &self,
        id: &OperationId,
    ) -> Box<dyn rho_r_api::CheckpointArtifactLease> {
        type ArtifactLocks = HashMap<PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>;
        static LOCKS: std::sync::OnceLock<Mutex<ArtifactLocks>> = std::sync::OnceLock::new();
        let lock = {
            let mut locks = LOCKS
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            locks.retain(|_, value| value.strong_count() > 0);
            let key = self.dir(id);
            if let Some(lock) = locks.get(&key).and_then(std::sync::Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        };
        Box::new(lock.lock_owned().await)
    }
    fn readonly(base: &Path, project: &Path) -> Result<Self, String> {
        let project_key = format!("{:x}", Sha256::digest(project.to_string_lossy().as_bytes()));
        let base = if base.exists() {
            base.canonicalize().map_err(|e| e.to_string())?
        } else {
            base.to_path_buf()
        };
        let root = base.join("checkpoints").join(project_key);
        if root.exists() {
            if fs::symlink_metadata(&root)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("Checkpoint archive symlink is not permitted".into());
            }
            let canonical = root.canonicalize().map_err(|e| e.to_string())?;
            if !canonical.starts_with(&base) {
                return Err("Checkpoint archive escapes private storage".into());
            }
            return Ok(Self { root: canonical });
        }
        Ok(Self { root })
    }

    pub(super) fn new(base: &Path, project: &Path) -> Result<Self, String> {
        let project_key = format!("{:x}", Sha256::digest(project.to_string_lossy().as_bytes()));
        let root = base.join("checkpoints").join(project_key);
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self { root })
    }
    fn dir(&self, id: &OperationId) -> PathBuf {
        self.root
            .join(format!("{:x}", Sha256::digest(id.as_str().as_bytes())))
    }
    fn checked(&self, path: &Path) -> Result<PathBuf, String> {
        let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Checkpoint symlinks are not permitted".into());
        }
        let actual = path.canonicalize().map_err(|e| e.to_string())?;
        if !actual.starts_with(&self.root) {
            return Err("Checkpoint path escapes private storage".into());
        }
        Ok(actual)
    }
    fn prepare(&self, id: &OperationId) -> Result<PathBuf, String> {
        let directory = self.dir(id);
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        self.checked(&directory)?;
        Ok(directory.join("payload.staging"))
    }
    fn sync_directory(path: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            fs::File::open(path)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn digest(&self, path: &Path, limit: u64) -> Result<(String, u64), String> {
        let path = self.checked(path)?;
        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > limit {
            return Err("Checkpoint payload exceeds bound or is not a file".into());
        }
        let bounded = limit
            .checked_add(1)
            .ok_or("Invalid checkpoint byte bound")?;
        let mut reader = fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(bounded);
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            count += n as u64;
            if count > limit {
                return Err("Checkpoint payload grew beyond bound".into());
            }
            hash.update(&buffer[..n]);
        }
        Ok((format!("sha256:{:x}", hash.finalize()), count))
    }
    fn finish_payload(&self, id: &OperationId, limit: u64) -> Result<(String, u64), String> {
        let directory = self.checked(&self.dir(id))?;
        let path = directory.join("payload.staging");
        let path = self.checked(&path)?;
        fs::File::open(&path)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        let digest = self.digest(&path, limit)?;
        let destination = directory.join("payload.rds");
        if destination.exists() {
            return Err("Immutable checkpoint payload already exists".into());
        }
        fs::rename(path, destination).map_err(|e| e.to_string())?;
        Self::sync_directory(&directory)?;
        Ok(digest)
    }
    fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), String> {
        let directory = self.checked(path.parent().ok_or("No checkpoint parent")?)?;
        let temporary = directory.join(format!(
            "{}.staging",
            path.file_name()
                .ok_or("No checkpoint filename")?
                .to_string_lossy()
        ));
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Err("Checkpoint manifest exceeds 1 MiB".into());
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        if path.exists() {
            return Err("Immutable checkpoint metadata already exists".into());
        }
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Self::sync_directory(&directory)
    }
    fn read_json<T: serde::de::DeserializeOwned>(&self, path: &Path) -> Result<T, String> {
        let path = self.checked(path)?;
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Err("Checkpoint metadata exceeds 1 MiB".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
    pub(super) fn original_manifest(
        &self,
        id: &OperationId,
    ) -> Result<Option<CheckpointManifest>, String> {
        let path = self.dir(id).join("manifest.json");
        if !path.exists() {
            return Ok(None);
        }
        let manifest: CheckpointManifest = self.read_json(&path)?;
        if &manifest.checkpoint_id != id {
            return Err("Checkpoint manifest operation identity differs".into());
        }
        Ok(Some(manifest))
    }
    pub(super) fn adopt(
        &self,
        source: &CheckpointManifest,
        adopted: &CheckpointManifest,
    ) -> Result<(), String> {
        if source.sha256 != adopted.sha256
            || source.byte_size != adopted.byte_size
            || source.checkpoint_id == adopted.checkpoint_id
        {
            return Err("Invalid checkpoint adoption identity".into());
        }
        if !self.verify(source)? {
            return Err("Original checkpoint payload failed integrity verification".into());
        }
        let original = self.checked(&self.dir(&source.checkpoint_id).join("payload.rds"))?;
        let staging = self.prepare(&adopted.checkpoint_id)?;
        // Independent link on the same private filesystem: later original deletion
        // does not remove the adopted copy, and restore never follows source paths.
        fs::hard_link(original, &staging).map_err(|e| e.to_string())?;
        let (hash, size) = self.finish_payload(&adopted.checkpoint_id, source.byte_size)?;
        if hash != source.sha256 || size != source.byte_size {
            return Err("Source artifact changed during adoption".into());
        }
        self.write_json(
            &self.dir(&adopted.checkpoint_id).join("manifest.json"),
            adopted,
        )
    }
    pub(super) fn candidates(&self) -> Result<Vec<CheckpointManifest>, String> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut values = Vec::new();
        let mut count = 0usize;
        let mut metadata_bytes = 0u64;
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            count += 1;
            if count > 4096 {
                return Err(
                    "Checkpoint storage scan exceeds 4096 entries; retention maintenance required"
                        .into(),
                );
            }
            let directory = self.checked(&path)?;
            if !directory.is_dir() {
                continue;
            }
            let manifest = directory.join("manifest.json");
            if !manifest.exists() {
                continue;
            }
            metadata_bytes += fs::metadata(&manifest).map_err(|e| e.to_string())?.len();
            if metadata_bytes > 8 * 1024 * 1024 {
                return Err(
                    "Checkpoint catalog metadata exceeds 8 MiB; narrow retention before reading"
                        .into(),
                );
            }
            let value: CheckpointManifest = self.read_json(&manifest)?;
            if self.dir(&value.checkpoint_id) != directory {
                return Err("Checkpoint identity differs from storage directory".into());
            }
            values.push(value);
        }
        Ok(values)
    }
    pub(super) fn controls(
        &self,
        id: &OperationId,
    ) -> Result<Vec<CheckpointControlEvidence>, String> {
        if !self.dir(id).exists() {
            return Ok(Vec::new());
        }
        let directory = self.checked(&self.dir(id))?;
        let mut values = Vec::new();
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".control.json"))
            {
                continue;
            }
            if values.len() >= 4096 {
                return Err("Checkpoint control history exceeds observation bound".into());
            }
            let evidence: CheckpointControlEvidence = self.read_json(&path)?;
            if &evidence.report.checkpoint_id != id {
                return Err("Checkpoint control identity mismatch".into());
            }
            values.push(evidence);
        }
        Ok(values)
    }
    pub(super) fn present(&self, manifest: &CheckpointManifest) -> Result<bool, String> {
        let path = self.dir(&manifest.checkpoint_id).join("payload.rds");
        if !path.exists() {
            return Ok(false);
        }
        let actual = self.checked(&path)?;
        let metadata = fs::metadata(actual).map_err(|e| e.to_string())?;
        Ok(metadata.is_file() && metadata.len() == manifest.byte_size)
    }
    pub(super) fn verify(&self, manifest: &CheckpointManifest) -> Result<bool, String> {
        if manifest.byte_size > 16 * 1024 * 1024 * 1024
            || manifest.sha256.len() != 71
            || !manifest.sha256.starts_with("sha256:")
        {
            return Err("Invalid checkpoint integrity metadata".into());
        }
        let path = self.dir(&manifest.checkpoint_id).join("payload.rds");
        if !path.exists() {
            return Ok(false);
        }
        let (hash, size) = self.digest(&path, manifest.byte_size)?;
        Ok(hash == manifest.sha256 && size == manifest.byte_size)
    }
}
#[derive(Deserialize)]
struct HelperManifest {
    r_home: String,
    r_version: String,
    platform: String,
    library: String,
    sha256: String,
}
pub fn verify_checkpoint_helper(path: &Path, r_home: &Path) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let manifest_path = path
        .parent()
        .ok_or("Missing helper directory")?
        .join("manifest.json");
    let mut metadata = Vec::new();
    fs::File::open(manifest_path)
        .map_err(|e| e.to_string())?
        .take(8193)
        .read_to_end(&mut metadata)
        .map_err(|e| e.to_string())?;
    if metadata.len() > 8192 {
        return Err("Checkpoint provider manifest exceeds 8 KiB".into());
    }
    let manifest: HelperManifest = serde_json::from_slice(&metadata).map_err(|e| e.to_string())?;
    if Path::new(&manifest.r_home)
        .canonicalize()
        .map_err(|e| e.to_string())?
        != r_home.canonicalize().map_err(|e| e.to_string())?
        || Path::new(&manifest.library)
            .canonicalize()
            .map_err(|e| e.to_string())?
            != path
    {
        return Err("Checkpoint provider manifest belongs to another R installation".into());
    }
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 16 * 1024 * 1024 {
        return Err("Checkpoint helper exceeds native component bound".into());
    }
    let hash = format!(
        "sha256:{:x}",
        Sha256::digest(fs::read(&path).map_err(|e| e.to_string())?)
    );
    if hash != manifest.sha256 {
        return Err("Checkpoint provider integrity check failed".into());
    }
    // Native startup also checks this exact version/platform before dyn.load.
    if manifest.r_version.is_empty() || manifest.platform.is_empty() {
        return Err("Checkpoint provider has no R ABI identity".into());
    }
    Ok(path)
}
impl ArkRuntime {
    pub(super) async fn capture_checkpoint(
        &self,
        op: &OperationId,
        args: &CheckpointCaptureArguments,
        cancel: watch::Receiver<bool>,
    ) -> Result<CheckpointArtifact, NativeError> {
        if !self.checkpoint_ready {
            return Err(before("Checkpoint native component unavailable"));
        }
        let path = self.checkpoints.prepare(op).map_err(before)?;
        let report = self.capture_native_graph(op, &path, args, cancel).await?;
        let store = self.checkpoints.clone();
        let id = op.clone();
        let limit = args.max_bytes;
        let (sha256, byte_size) =
            tokio::task::spawn_blocking(move || store.finish_payload(&id, limit))
                .await
                .map_err(before)?
                .map_err(before)?;
        Ok(CheckpointArtifact {
            report,
            sha256,
            byte_size,
        })
    }
    pub(super) async fn capture_native_graph(
        &self,
        op: &OperationId,
        path: &Path,
        args: &CheckpointCaptureArguments,
        cancel: watch::Receiver<bool>,
    ) -> Result<CheckpointNativeReport, NativeError> {
        let payload = json!({"path":path,"max_bytes":args.max_bytes,"max_seconds":args.max_seconds,"project_root":self.project_root,"include_names":args.include_names,"exclude_names":args.exclude_names,"include_patterns":args.include_patterns,"exclude_patterns":args.exclude_patterns});
        let (response, _, _) = self
            .bridge_call(
                op.as_str(),
                BridgeAction::CheckpointCapture(&payload),
                cancel,
            )
            .await?;
        if response.outcome != OperationOutcome::Succeeded {
            let mut error = NativeError::before_effect(
                response
                    .error
                    .unwrap_or_else(|| "Checkpoint capture failed".into()),
            );
            if response.outcome == OperationOutcome::Cancelled {
                error.query_code = Some("checkpoint_cancelled".into());
            }
            return Err(error);
        }
        serde_json::from_value(response.value).map_err(before)
    }
    pub(super) async fn restore_checkpoint(
        &self,
        op: &OperationId,
        manifest: &CheckpointManifest,
        cancel: watch::Receiver<bool>,
    ) -> Result<CheckpointNativeRestoreReport, NativeError> {
        if !self.checkpoint_ready {
            return Err(before("Checkpoint native component unavailable"));
        }
        let store = self.checkpoints.clone();
        let captured_manifest = manifest.clone();
        if !tokio::task::spawn_blocking(move || store.verify(&captured_manifest))
            .await
            .map_err(before)?
            .map_err(before)?
        {
            return Err(before("Checkpoint payload integrity differs"));
        }
        self.restore_native_graph(
            op,
            &self
                .checkpoints
                .dir(&manifest.checkpoint_id)
                .join("payload.rds"),
            &manifest.report,
            cancel,
        )
        .await
    }
    pub(super) async fn restore_native_graph(
        &self,
        op: &OperationId,
        path: &Path,
        report: &CheckpointNativeReport,
        cancel: watch::Receiver<bool>,
    ) -> Result<CheckpointNativeRestoreReport, NativeError> {
        let payload = json!({"path":path,"r_version":report.r_version,"platform":report.platform,"library_paths":report.library_paths,"package_inventory_digest":report.package_inventory_digest,"saved_names":report.saved_names,"project_root":self.project_root,"working_directory":report.working_directory,"safe_options":report.safe_options,"required_core_namespaces":report.required_core_namespaces,"required_class_namespaces":report.required_class_namespaces,"max_bytes":16u64*1024*1024*1024});
        let (response, _, _) = self
            .bridge_call(
                op.as_str(),
                BridgeAction::CheckpointRestore(&payload),
                cancel,
            )
            .await?;
        if response.outcome != OperationOutcome::Succeeded {
            let mut error = NativeError::after_possible_effect(
                response
                    .error
                    .unwrap_or_else(|| "Checkpoint restore failed".into()),
                Some(json!(CheckpointRecovery {
                    operation_id: op.clone(),
                    native_session_id: self.session_id.clone(),
                    action: "inspect_candidate_before_retry".into(),
                    automatic_reexecution: false
                })),
            );
            if response.outcome == OperationOutcome::Cancelled {
                error.query_code = Some("checkpoint_cancelled".into());
            }
            return Err(error);
        }
        serde_json::from_value(response.value)
            .map_err(|e| NativeError::after_possible_effect(e.to_string(), None))
    }
    pub(super) fn publish_checkpoint(
        &self,
        manifest: &CheckpointManifest,
    ) -> Result<(), NativeError> {
        self.checkpoints
            .write_json(
                &self
                    .checkpoints
                    .dir(&manifest.checkpoint_id)
                    .join("manifest.json"),
                manifest,
            )
            .map_err(before)
    }
    pub(super) fn write_checkpoint_control(
        &self,
        evidence: &CheckpointControlEvidence,
    ) -> Result<(), NativeError> {
        let filename = format!(
            "{:x}.control.json",
            Sha256::digest(evidence.operation_id.as_str().as_bytes())
        );
        self.checkpoints
            .write_json(
                &self
                    .checkpoints
                    .dir(&evidence.report.checkpoint_id)
                    .join(filename),
                evidence,
            )
            .map_err(before)
    }
    pub(super) fn remove_checkpoint_payload(&self, id: &OperationId) -> Result<(), String> {
        let path = self.checkpoints.dir(id).join("payload.rds");
        if !path.exists() {
            return Ok(());
        }
        let path = self.checkpoints.checked(&path)?;
        fs::remove_file(path).map_err(|e| e.to_string())?;
        CheckpointStore::sync_directory(&self.checkpoints.dir(id))
    }
}

/// Opens only project-private artifact storage. No Client, R process, native
/// bootstrap, checkpoint replay, or scientific recovery is constructed here.
pub struct CheckpointArchiveRuntime {
    store: CheckpointStore,
    project: String,
}
impl CheckpointArchiveRuntime {
    pub fn open(project: &Path, data_root: &Path) -> Result<Self, String> {
        let project = project.canonicalize().map_err(|e| e.to_string())?;
        Ok(Self {
            store: CheckpointStore::readonly(data_root, &project)?,
            project: project.to_string_lossy().into_owned(),
        })
    }
}
#[async_trait]
impl NativeRuntime for CheckpointArchiveRuntime {
    fn session_id(&self) -> &str {
        "checkpoint-archive"
    }
    fn project_root(&self) -> Option<&str> {
        Some(&self.project)
    }
    fn checkpoint_archive_only(&self) -> bool {
        true
    }
    async fn checkpoint_artifact_lease(
        &self,
        id: &OperationId,
    ) -> Result<Box<dyn rho_r_api::CheckpointArtifactLease>, NativeError> {
        Ok(self.store.artifact_lease(id).await)
    }
    async fn checkpoint_original_manifest(
        &self,
        id: &OperationId,
    ) -> Result<Option<CheckpointManifest>, NativeError> {
        self.store.original_manifest(id).map_err(before)
    }
    async fn checkpoint_adopt(
        &self,
        source: &CheckpointManifest,
        adopted: &CheckpointManifest,
    ) -> Result<(), NativeError> {
        let store = self.store.clone();
        let source = source.clone();
        let adopted = adopted.clone();
        tokio::task::spawn_blocking(move || store.adopt(&source, &adopted))
            .await
            .map_err(before)?
            .map_err(before)
    }
    async fn checkpoint_candidates(&self) -> Result<Vec<CheckpointManifest>, NativeError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.candidates())
            .await
            .map_err(before)?
            .map_err(before)
    }
    async fn checkpoint_control_evidence(
        &self,
        id: &OperationId,
    ) -> Result<Vec<CheckpointControlEvidence>, NativeError> {
        self.store.controls(id).map_err(before)
    }
    async fn checkpoint_write_control(
        &self,
        evidence: &CheckpointControlEvidence,
    ) -> Result<(), NativeError> {
        let filename = format!(
            "{:x}.control.json",
            Sha256::digest(evidence.operation_id.as_str().as_bytes())
        );
        self.store
            .write_json(
                &self
                    .store
                    .dir(&evidence.report.checkpoint_id)
                    .join(filename),
                evidence,
            )
            .map_err(before)
    }
    async fn checkpoint_present(&self, manifest: &CheckpointManifest) -> Result<bool, NativeError> {
        self.store.present(manifest).map_err(before)
    }
    async fn checkpoint_verify(&self, manifest: &CheckpointManifest) -> Result<bool, NativeError> {
        let store = self.store.clone();
        let manifest = manifest.clone();
        tokio::task::spawn_blocking(move || store.verify(&manifest))
            .await
            .map_err(before)?
            .map_err(before)
    }
    fn checkpoint_remove_payload(&self, id: &OperationId) -> Result<(), String> {
        let path = self.store.dir(id).join("payload.rds");
        if !path.exists() {
            return Ok(());
        }
        let path = self.store.checked(&path)?;
        fs::remove_file(path).map_err(|e| e.to_string())?;
        CheckpointStore::sync_directory(&self.store.dir(id))
    }
    async fn execute(
        &self,
        _: &OperationId,
        _: &RunRArguments,
    ) -> Result<NativeReport, NativeError> {
        Err(before(
            "This is a read-only checkpoint archive, not a live R process",
        ))
    }
}

impl ArkRuntime {
    pub(super) async fn shutdown_confirmed(&self) -> Result<(), NativeError> {
        let Some((pid, recorded_start)) = self.native_process else {
            return Err(before(
                "Original native process identity is unavailable; stop cannot be confirmed",
            ));
        };
        let identity = process_start(pid).await?;
        if identity.is_none() || identity != Some(recorded_start) {
            self.client.lock().unwrap_or_else(|e| e.into_inner()).take();
            return Ok(());
        }
        let mut client = {
            let mut slot = self.client.lock().unwrap_or_else(|e| e.into_inner());
            let Some(existing) = slot.as_ref() else {
                return Err(NativeError::after_possible_effect(
                    "Original R process still exists but its native handle is unavailable",
                    Some(
                        json!({"session_id":self.session_id,"pid":pid,"process_start":recorded_start}),
                    ),
                ));
            };
            if Arc::strong_count(existing) != 1 {
                return Err(before(
                    "Native R has active observation/execution leases; shutdown was not started",
                ));
            }
            let value = slot.take().unwrap();
            match Arc::try_unwrap(value) {
                Ok(client) => client,
                Err(value) => {
                    *slot = Some(value);
                    return Err(before("Native R lease changed; shutdown was not started"));
                }
            }
        };
        self.closing
            .store(true, std::sync::atomic::Ordering::Release);
        self.input_changed.send_modify(|v| *v = v.wrapping_add(1));
        let _ = tokio::time::timeout(Duration::from_secs(1), client.shutdown()).await;
        drop(client); // Jet's owned ChildGuard terminates/reaps its own child.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let current = process_start(pid).await?;
            if current.is_none() || (identity.is_some() && current != identity) {
                self.input.lock().unwrap_or_else(|e| e.into_inner()).take();
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(NativeError::after_possible_effect(
                    "Original R process still exists after shutdown deadline",
                    Some(
                        json!({"session_id":self.session_id,"pid":pid,"process_start":identity,"action":"inspect_original_process_before_replacement"}),
                    ),
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
pub(super) async fn process_start(pid: u32) -> Result<Option<u64>, NativeError> {
    tokio::task::spawn_blocking(move || {
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        system
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.start_time())
    })
    .await
    .map_err(before)
}

/// Observe an originally recorded process without connecting to or signalling it.
pub async fn recorded_process_alive(
    identity: &RuntimeProcessIdentity,
) -> Result<Option<bool>, String> {
    process_start(identity.pid)
        .await
        .map(|current| Some(current == Some(identity.start_time)))
        .map_err(|e| e.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(store: &CheckpointStore, id: &OperationId) -> CheckpointManifest {
        let staging = store.prepare(id).unwrap();
        fs::write(staging, b"original graph bytes").unwrap();
        let (sha256, byte_size) = store.finish_payload(id, 1024).unwrap();
        CheckpointManifest {
            source_operation_id: None,
            runtime_binding: None,
            checkpoint_id: id.clone(),
            workspace_instance_id: "main".into(),
            native_session_id: "native-original".into(),
            continuation_lineage_id: "lineage-original".into(),
            environment_fingerprint: None,
            activity_boundary: 7,
            created_at_ms: 123,
            sha256,
            byte_size,
            report: CheckpointNativeReport {
                saved_names: vec!["x".into()],
                skipped: vec![],
                r_version: "4.5.2".into(),
                platform: "test".into(),
                library_paths: vec![],
                package_inventory_digest: "inventory".into(),
                working_directory: Some(".".into()),
                safe_options: CheckpointSafeOptions {
                    digits: Some(7),
                    width: Some(80),
                    scipen: Some(0),
                    out_dec: Some(".".into()),
                    warn: Some(0),
                },
                context_notices: vec![],
                required_core_namespaces: vec![],
                required_class_namespaces: vec![],
                coverage: CheckpointCoverage::CompleteEligibleGraph,
            },
            automatic: true,
            validation: "test-only-native-bytes".into(),
        }
    }
    #[test]
    fn unpublished_artifacts_are_not_catalog_entries_and_immutable_publication_is_verified() {
        let temp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(temp.path(), temp.path()).unwrap();
        let id = OperationId::new("capture-original").unwrap();
        let manifest = fixture(&store, &id);
        assert!(store.candidates().unwrap().is_empty());
        assert!(store.verify(&manifest).unwrap());
        store
            .write_json(&store.dir(&id).join("manifest.json"), &manifest)
            .unwrap();
        assert_eq!(store.candidates().unwrap(), vec![manifest.clone()]);
        assert!(store.prepare(&id).is_err());
        assert!(
            store
                .write_json(&store.dir(&id).join("manifest.json"), &manifest)
                .is_err()
        );
        fs::write(store.dir(&id).join("payload.rds"), b"modified graph bytes").unwrap();
        assert!(!store.verify(&manifest).unwrap());
    }
    #[test]
    fn metadata_presence_does_not_claim_fresh_integrity_and_controls_are_only_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(temp.path(), temp.path()).unwrap();
        let id = OperationId::new("capture-control").unwrap();
        let manifest = fixture(&store, &id);
        let path = store.dir(&id).join("payload.rds");
        fs::write(&path, vec![0u8; manifest.byte_size as usize]).unwrap();
        assert!(store.present(&manifest).unwrap());
        assert!(!store.verify(&manifest).unwrap());
        let evidence = CheckpointControlEvidence {
            operation_id: OperationId::new("pin-original").unwrap(),
            report: CheckpointControlReport {
                checkpoint_id: id.clone(),
                pinned: true,
                deleted: false,
            },
            at_ms: 20,
        };
        store
            .write_json(&store.dir(&id).join("test.control.json"), &evidence)
            .unwrap();
        assert_eq!(store.controls(&id).unwrap().len(), 1);
        assert!(
            path.exists(),
            "Control evidence cannot directly delete payloads before a journal commit"
        );
    }
    #[tokio::test]
    async fn independent_runtime_and_archive_stores_share_artifact_leases() {
        let temp = tempfile::tempdir().unwrap();
        let writer = CheckpointStore::new(temp.path(), temp.path()).unwrap();
        let archive = CheckpointStore::readonly(temp.path(), temp.path()).unwrap();
        let id = OperationId::new("leased-source").unwrap();
        let original = writer.artifact_lease(&id).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), archive.artifact_lease(&id))
                .await
                .is_err()
        );
        drop(original);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), archive.artifact_lease(&id))
                .await
                .is_ok()
        );
    }
    #[test]
    fn archive_open_does_not_create_storage_and_adoption_retains_independent_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let absent = temp.path().join("not-created");
        let archive = CheckpointArchiveRuntime::open(temp.path(), &absent).unwrap();
        assert!(!absent.exists());
        assert!(archive.store.candidates().unwrap().is_empty());
        assert!(!absent.exists());
        let store = CheckpointStore::new(temp.path(), temp.path()).unwrap();
        let id = OperationId::new("uncertain-original").unwrap();
        let original = fixture(&store, &id);
        store
            .write_json(&store.dir(&id).join("manifest.json"), &original)
            .unwrap();
        let mut adopted = original.clone();
        adopted.checkpoint_id = OperationId::new("reconciliation-copy").unwrap();
        adopted.source_operation_id = Some(id.clone());
        store.adopt(&original, &adopted).unwrap();
        fs::remove_file(store.dir(&id).join("payload.rds")).unwrap();
        assert!(store.verify(&adopted).unwrap());
        assert_eq!(
            store.original_manifest(&adopted.checkpoint_id).unwrap(),
            Some(adopted)
        );
    }
    #[cfg(unix)]
    #[test]
    fn artifact_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(temp.path(), temp.path()).unwrap();
        let id = OperationId::new("capture-symlink").unwrap();
        let manifest = fixture(&store, &id);
        let path = store.dir(&id).join("payload.rds");
        fs::remove_file(&path).unwrap();
        let outside = temp.path().join("external");
        fs::write(&outside, b"original graph bytes").unwrap();
        symlink(outside, path).unwrap();
        assert!(store.verify(&manifest).is_err());
        assert!(store.present(&manifest).is_err());
    }
}
