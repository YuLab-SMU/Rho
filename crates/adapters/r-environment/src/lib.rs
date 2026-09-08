#![forbid(unsafe_code)]

mod observation;
mod retention;
use async_trait::async_trait;
use rho_environment::{
    EnvironmentObservation, EnvironmentPlan, EnvironmentRealization, EnvironmentReconcileRecovery,
    EnvironmentReconciliation, EnvironmentRuntime, EnvironmentRuntimeRecovery,
    EnvironmentStageRecovery, MaterialAction, MaterialChange, MaterialKind, MaterialState,
    NamespaceProbe, PackageVersion, PlanArguments, SourceDigest, Verification,
};
use rho_operation::{Clock, HandlerError, SystemClock};
use rho_process::{ProcessOptions, ProcessTermination, run_command};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tempfile::{NamedTempFile, TempDir};
use tokio::sync::watch;

const HELPER: &str = include_str!("../../../../r/environment/helper.R");
const VERIFY: &str = include_str!("../../../../r/environment/verify.R");
const PROCESS_TREE: &str = include_str!("../../../../r/environment/process-tree.R");
const MAX_RESULT: u64 = 4 * 1024 * 1024;
const MAX_TREE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub struct REnvironmentConfig {
    pub rscript: PathBuf,
    pub project_root: PathBuf,
    pub data_root: PathBuf,
    pub timeout: Duration,
}
pub struct REnvironment {
    config: REnvironmentConfig,
    root: String,
    helper: NamedTempFile,
    verifier: NamedTempFile,
    process_tree: NamedTempFile,
    observation: Mutex<Result<observation::NativeConfiguration, String>>,
}
#[derive(Deserialize)]
struct Response {
    protocol_version: u16,
    request_id: String,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct NativePlan {
    r_version: String,
    platform: String,
    packages: Vec<PackageVersion>,
    local_sources: Vec<String>,
}
#[derive(Deserialize)]
struct NativeVerification {
    r_version: String,
    platform: String,
    probes: Vec<NamespaceProbe>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryMarker {
    schema_version: u16,
    operation_id: String,
    project_root: String,
    marker: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeCleanup {
    stopped_pids: Vec<u32>,
    remaining_pids: Vec<u32>,
}

impl REnvironment {
    pub fn open(mut config: REnvironmentConfig) -> Result<Self, String> {
        config.rscript = config.rscript.canonicalize().map_err(display)?;
        config.project_root = config.project_root.canonicalize().map_err(display)?;
        if !config.project_root.is_dir() || config.timeout.is_zero() {
            return Err("invalid Environment runtime configuration".into());
        }
        std::fs::create_dir_all(&config.data_root).map_err(display)?;
        config.data_root = config.data_root.canonicalize().map_err(display)?;
        let helper = NamedTempFile::new_in(&config.data_root).map_err(display)?;
        let verifier = NamedTempFile::new_in(&config.data_root).map_err(display)?;
        let process_tree = NamedTempFile::new_in(&config.data_root).map_err(display)?;
        std::fs::write(helper.path(), HELPER).map_err(display)?;
        std::fs::write(verifier.path(), VERIFY).map_err(display)?;
        std::fs::write(process_tree.path(), PROCESS_TREE).map_err(display)?;
        Ok(Self {
            root: config.project_root.to_string_lossy().into_owned(),
            config,
            helper,
            verifier,
            process_tree,
            observation: Mutex::new(Err("Native Environment configuration has not been established during explicit Host startup or an Environment operation.".into())),
        })
    }
    fn source_path(&self, value: &str) -> Result<PathBuf, String> {
        let path = Path::new(value);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.config.project_root.join(path)
        };
        let canonical = path.canonicalize().map_err(display)?;
        if !canonical.starts_with(&self.config.project_root) {
            return Err("local environment sources must be contained in the project".into());
        }
        if canonical.is_dir() && self.config.data_root.starts_with(&canonical) {
            return Err("place Environment data outside the local source package to avoid self-containing builds".into());
        }
        Ok(canonical)
    }
    fn owned_path(&self, value: &str) -> Result<PathBuf, String> {
        let path = Path::new(value).canonicalize().map_err(display)?;
        if !path.starts_with(&self.config.data_root) {
            return Err("Environment reference is outside its data directory".into());
        }
        Ok(path)
    }
    fn stage(&self, kind: &str, id: &str) -> Result<PathBuf, String> {
        let directory = self
            .config
            .data_root
            .join(kind)
            .join(format!("{:x}", Sha256::digest(id.as_bytes())));
        std::fs::create_dir_all(directory.parent().unwrap()).map_err(display)?;
        std::fs::create_dir(&directory)
            .map_err(|e| format!("Environment staging is not new: {e}"))?;
        Ok(directory)
    }
    fn recovery_path(&self, id: &str) -> Result<PathBuf, String> {
        let directory = self.config.data_root.join("recovery");
        if directory.exists() && directory.canonicalize().map_err(display)? != directory {
            return Err("Environment recovery directory identity changed".into());
        }
        Ok(directory.join(format!("{:x}.json", Sha256::digest(id.as_bytes()))))
    }
    fn persist_marker(&self, file: NamedTempFile, id: &str, marker: &str) -> Result<(), String> {
        if self.config.data_root.canonicalize().map_err(display)? != self.config.data_root {
            return Err("Environment data root identity changed".into());
        }
        std::fs::create_dir_all(self.config.data_root.join("recovery")).map_err(display)?;
        let target = self.recovery_path(id)?;
        let material = RecoveryMarker {
            schema_version: 1,
            operation_id: id.into(),
            project_root: self.root.clone(),
            marker: marker.into(),
        };
        std::fs::write(file.path(), serde_json::to_vec(&material).map_err(display)?)
            .map_err(display)?;
        file.as_file().sync_all().map_err(display)?;
        // Replace only after the previous helper has completed confirmed cleanup.
        // A crash sees either its old (already stopped) marker or the new marker.
        file.persist(&target).map_err(display)?;
        #[cfg(unix)]
        std::fs::File::open(target.parent().unwrap())
            .and_then(|dir| dir.sync_all())
            .map_err(display)?;
        Ok(())
    }
    fn read_marker(&self, id: &str) -> Result<Option<RecoveryMarker>, String> {
        let path = self.recovery_path(id)?;
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(display(error)),
        };
        if !metadata.is_file()
            || metadata.len() > 4096
            || path.canonicalize().map_err(display)? != path
        {
            return Err("invalid Environment recovery file".into());
        }
        let material: RecoveryMarker =
            serde_json::from_slice(&read_bounded(&path)?).map_err(display)?;
        if material.schema_version != 1
            || material.operation_id != id
            || material.project_root != self.root
            || !valid_marker(&material.marker)
        {
            return Err("Environment recovery reference identity mismatch".into());
        }
        Ok(Some(material))
    }
    async fn helper_call(
        &self,
        id: Option<&str>,
        action: &str,
        payload: Value,
        cancellation: watch::Receiver<bool>,
    ) -> Result<Value, HandlerError> {
        let request_id = id.unwrap_or("observe");
        let scratch = TempDir::new_in(&self.config.data_root).map_err(before)?;
        let input = scratch.path().join("request.json");
        let output = scratch.path().join("result.json");
        std::fs::write(
            &input,
            serde_json::to_vec(
                &json!({"protocol_version":1,"request_id":request_id,"action":action,"payload":payload}),
            )
            .map_err(before)?,
        )
        .map_err(before)?;
        self.run(
            id,
            self.helper.path(),
            &[
                input.to_string_lossy().into_owned(),
                output.to_string_lossy().into_owned(),
            ],
            cancellation,
        )
        .await?;
        let value = response(&output, request_id).map_err(uncertain)?;
        if action == "observe" {
            self.remember_configuration(&value, id).map_err(uncertain)?;
        }
        Ok(value)
    }
    async fn run(
        &self,
        id: Option<&str>,
        script: &Path,
        args: &[String],
        cancellation: watch::Receiver<bool>,
    ) -> Result<(), HandlerError> {
        // Let ps allocate its own native marker format; never invent a parallel
        // process registry. The marker is inherited across detached callr groups.
        let marker_file = NamedTempFile::new_in(&self.config.data_root).map_err(before)?;
        self.tree_action("mark", &marker_file.path().to_string_lossy(), None)
            .await
            .map_err(before)?;
        let marker = String::from_utf8(read_bounded(marker_file.path()).map_err(before)?)
            .map_err(before)?
            .trim()
            .to_string();
        if !valid_marker(&marker) {
            return Err(before("ps returned an invalid process-tree marker"));
        }
        // Explicit Host startup has no Operation identity; keep its marker
        // ephemeral. Queries never enter this runtime execution path.
        let _ephemeral_marker = if let Some(id) = id {
            self.persist_marker(marker_file, id, &marker)
                .map_err(before)?;
            None
        } else {
            Some(marker_file)
        };
        let mut command = tokio::process::Command::new(&self.config.rscript);
        command
            .arg("--vanilla")
            .arg(script)
            .args(args)
            .current_dir(&self.config.project_root)
            .env(&marker, "YES");
        if let Some(id) = id {
            command.env("RHO_OPERATION_ID", id);
        } else {
            command.env_remove("RHO_OPERATION_ID");
        }
        command
            .env("RENV_CONFIG_CACHE_ENABLED", "FALSE")
            .env("RENV_CONFIG_AUTO_SNAPSHOT", "FALSE")
            .env("RENV_CONFIG_SYNCHRONIZED_CHECK", "FALSE")
            .env("RENV_CONFIG_PAK_ENABLED", "FALSE");
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy().to_ascii_uppercase();
            if key.contains("TOKEN")
                || key.contains("SECRET")
                || key.contains("PASSWORD")
                || key.ends_with("KEY")
            {
                command.env_remove(name);
            }
        }
        let mut report = run_command(
            command,
            ProcessOptions {
                timeout: self.config.timeout,
                output_limit_bytes: MAX_RESULT as usize,
                stdin: None,
            },
            cancellation,
        )
        .await
        .map_err(before)?;
        // This cleanup is deliberately not cancelled with the main action.
        // A stopped leader alone is insufficient proof for a package install.
        let tree_cleanup = self.cleanup_tree(&marker, id.unwrap_or("")).await;
        if let Err(error) = &tree_cleanup {
            report.termination = ProcessTermination::Uncertain;
            report.cleanup_error = Some(error.clone());
        }
        if report.termination == ProcessTermination::Exited && report.exit_code == Some(0) {
            return Ok(());
        }
        // Error recovery retains bounded diagnostics, never a multi-MiB copy of
        // package-manager chatter inside the Operation record.
        for capture in [&mut report.stdout, &mut report.stderr] {
            capture.truncated |= capture.bytes.len() > 4000;
            capture.bytes.truncate(4000);
        }
        let message = format!(
            "R helper {:?}, exit {:?}: {} {}",
            report.termination,
            report.exit_code,
            String::from_utf8_lossy(&report.stdout.bytes),
            String::from_utf8_lossy(&report.stderr.bytes)
        );
        let recovery = Some(json!(EnvironmentRuntimeRecovery {
            process: report.clone(),
            process_tree_marker: marker,
            tree_cleanup_confirmed: tree_cleanup.is_ok(),
            action: "inspect_staged_effects_before_retry".into(),
        }));
        Err(if report.termination == ProcessTermination::Cancelled {
            HandlerError::cancelled(message, recovery)
        } else {
            HandlerError::after_possible_effect(message, recovery)
        })
    }
    async fn tree_action(
        &self,
        action: &str,
        value: &str,
        owner_tag: Option<&str>,
    ) -> Result<String, String> {
        let mut command = tokio::process::Command::new(&self.config.rscript);
        command
            .arg("--vanilla")
            .arg(self.process_tree.path())
            .args([action, value])
            .current_dir(&self.config.project_root);
        if let Some(tag) = owner_tag {
            command.arg(tag);
        }
        let report = run_command(
            command,
            ProcessOptions {
                timeout: Duration::from_secs(10),
                output_limit_bytes: 4000,
                stdin: None,
            },
            watch::channel(false).1,
        )
        .await
        .map_err(display)?;
        if report.termination != ProcessTermination::Exited || report.exit_code != Some(0) {
            return Err(format!(
                "ps process-tree {action} failed ({:?}): {}",
                report.termination,
                String::from_utf8_lossy(&report.stderr.bytes)
            ));
        }
        if report.stdout.truncated || report.stderr.truncated {
            return Err("ps process-tree report exceeded its byte bound".into());
        }
        String::from_utf8(report.stdout.bytes).map_err(display)
    }
    async fn cleanup_tree(&self, marker: &str, id: &str) -> Result<NativeCleanup, String> {
        let report: NativeCleanup =
            serde_json::from_str(&self.tree_action("cleanup", marker, Some(id)).await?)
                .map_err(display)?;
        if !report.remaining_pids.is_empty() {
            return Err("marked descendants are still running".into());
        }
        Ok(report)
    }
    async fn probes(
        &self,
        id: &str,
        library: &str,
        packages: &[PackageVersion],
        cancellation: watch::Receiver<bool>,
    ) -> Result<NativeVerification, HandlerError> {
        let native = self
            .helper_call(
                Some(id),
                "observe",
                json!({"library":null,"limit":1}),
                cancellation.clone(),
            )
            .await?;
        let support = native["jsonlite_library"]
            .as_str()
            .ok_or_else(|| before("jsonlite support library unavailable"))?;
        let scratch = TempDir::new_in(&self.config.data_root).map_err(before)?;
        let output = scratch.path().join("verify.json");
        let mut args = vec![
            library.into(),
            support.into(),
            output.to_string_lossy().into_owned(),
            id.into(),
        ];
        for package in packages {
            validate_package(package).map_err(before)?;
            args.push(format!("{}@{}", package.name, package.version));
        }
        self.run(Some(id), self.verifier.path(), &args, cancellation)
            .await?;
        serde_json::from_value(response(&output, id).map_err(uncertain)?).map_err(uncertain)
    }
    async fn check_sources(&self, sources: &[SourceDigest]) -> Result<(), String> {
        for source in sources {
            let path = self.source_path(&source.path)?;
            if digest(&path).await? != source.sha256 {
                return Err(format!(
                    "local source changed after planning: {}",
                    source.path
                ));
            }
        }
        Ok(())
    }
}

#[async_trait]
impl EnvironmentRuntime for REnvironment {
    fn root(&self) -> &str {
        &self.root
    }
    async fn material_state(
        &self,
        source_id: &str,
        kind: MaterialKind,
        cleanup_id: Option<&str>,
    ) -> Result<MaterialState, String> {
        self.inspect_material(source_id, kind, cleanup_id).await
    }
    async fn change_material(
        &self,
        source_id: &str,
        kind: MaterialKind,
        cleanup_id: &str,
        action: MaterialAction,
        expected_fingerprint: &str,
    ) -> Result<MaterialChange, HandlerError> {
        self.apply_material_change(source_id, kind, cleanup_id, action, expected_fingerprint)
            .await
    }
    async fn reconcile(
        &self,
        operation_id: &str,
    ) -> Result<EnvironmentReconciliation, HandlerError> {
        let material = self.read_marker(operation_id).map_err(before)?;
        let mut retained_stage_paths = Vec::new();
        for kind in ["plans", "realizations"] {
            let path = self
                .config
                .data_root
                .join(kind)
                .join(format!("{:x}", Sha256::digest(operation_id.as_bytes())));
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if !metadata.is_dir() || path.canonicalize().map_err(before)? != path {
                        return Err(before("Environment staging identity changed"));
                    }
                    retained_stage_paths.push(path.to_string_lossy().into_owned());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(before(error)),
            }
        }
        let mut report = EnvironmentReconciliation {
            source_operation_id: operation_id.into(),
            project_root: self.root.clone(),
            native_marker: material.as_ref().map(|material| material.marker.clone()),
            cleanup_confirmed: false,
            stopped_pids: Vec::new(),
            retained_stage_paths,
            notices: Vec::new(),
        };
        if let Some(material) = material {
            let cleanup = self
                .cleanup_tree(&material.marker, operation_id)
                .await
                .map_err(|error| {
                    HandlerError::after_possible_effect(
                        error,
                        Some(json!(EnvironmentReconcileRecovery {
                            source_operation_id: operation_id.into(),
                            process_tree_marker: Some(material.marker),
                            action: "reconcile_again_without_reexecuting_source".into(),
                        })),
                    )
                })?;
            report.stopped_pids = cleanup.stopped_pids;
            report.cleanup_confirmed = true;
            report.notices.push("Native marked children stopped; staged files were retained and no library was activated. This does not establish the original operation outcome.".into());
        } else {
            report.notices.push("No durable native process-tree reference exists; absence is not proof of completed cleanup.".into());
        }
        Ok(report)
    }
    async fn observe(
        &self,
        library: Option<&str>,
        limit: usize,
    ) -> Result<EnvironmentObservation, String> {
        self.observe_filesystem(library, limit).await
    }
    async fn plan(
        &self,
        operation_id: &str,
        args: &PlanArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<EnvironmentPlan, HandlerError> {
        let stage = self.stage("plans", operation_id).map_err(before)?;
        let lock_path = stage.join("source.lock");
        let library = stage.join("empty-library");
        std::fs::create_dir(&library).map_err(before)?;
        let mut inputs = BTreeSet::new();
        let (manager, native) = match args {
            PlanArguments::Pak { packages } => {
                let mut normalized = Vec::new();
                for package in packages {
                    let mut reference = package.clone();
                    for prefix in ["local::", "deps::"] {
                        if let Some(path) = package.strip_prefix(prefix) {
                            let path = self.source_path(path).map_err(before)?;
                            inputs.insert(path.clone());
                            reference = format!("{prefix}{}", path.to_string_lossy());
                        }
                    }
                    normalized.push(reference);
                }
                (
                    "pak",
                    self.helper_call(
                        Some(operation_id),
                        "plan_pak",
                        json!({"packages":normalized,"lockfile":lock_path,"library":library}),
                        cancellation.clone(),
                    )
                    .await?,
                )
            }
            PlanArguments::Renv { lockfile } => {
                let source = self.source_path(lockfile).map_err(before)?;
                let bytes = read_bounded(&source).map_err(before)?;
                let mut lock: Value = serde_json::from_slice(&bytes).map_err(before)?;
                if let Some(packages) = lock.get_mut("Packages").and_then(Value::as_object_mut) {
                    for record in packages.values_mut() {
                        let path = record
                            .get("Path")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .or_else(|| {
                                record
                                    .get("RemotePkgRef")
                                    .and_then(Value::as_str)
                                    .and_then(|reference| reference.strip_prefix("local::"))
                                    .map(str::to_string)
                            });
                        if let Some(path) = path {
                            record["Path"] = json!(self.source_path(&path).map_err(before)?);
                        }
                    }
                }
                std::fs::write(
                    &lock_path,
                    serde_json::to_vec_pretty(&lock).map_err(before)?,
                )
                .map_err(before)?;
                (
                    "renv",
                    self.helper_call(
                        Some(operation_id),
                        "plan_renv",
                        json!({"lockfile":lock_path}),
                        cancellation,
                    )
                    .await?,
                )
            }
        };
        let native: NativePlan = serde_json::from_value(native).map_err(uncertain)?;
        if native.packages.len() > 512 {
            return Err(before("Environment plan exceeds 512 packages"));
        }
        let mut names = BTreeSet::new();
        for package in &native.packages {
            validate_package(package).map_err(before)?;
            if !names.insert(&package.name) {
                return Err(before("duplicate package in native lockfile"));
            }
        }
        for path in &native.local_sources {
            inputs.insert(self.source_path(path).map_err(before)?);
        }
        let mut local_sources = Vec::new();
        for path in inputs {
            local_sources.push(SourceDigest {
                sha256: digest(&path).await.map_err(before)?,
                path: path.to_string_lossy().into_owned(),
            });
        }
        Ok(EnvironmentPlan {
            project_root: self.root.clone(),
            manager: manager.into(),
            lock_digest: hash(&read_bounded(&lock_path).map_err(before)?),
            lock_path: lock_path.to_string_lossy().into_owned(),
            r_version: native.r_version,
            platform: native.platform,
            packages: native.packages,
            local_sources,
        })
    }
    async fn realize(
        &self,
        operation_id: &str,
        plan_id: &str,
        plan: &EnvironmentPlan,
        cancellation: watch::Receiver<bool>,
    ) -> Result<EnvironmentRealization, HandlerError> {
        if plan.project_root != self.root {
            return Err(before("plan belongs to another project"));
        }
        let lock = self.owned_path(&plan.lock_path).map_err(before)?;
        if hash(&read_bounded(&lock).map_err(before)?) != plan.lock_digest {
            return Err(before("native lockfile changed after planning"));
        }
        self.check_sources(&plan.local_sources)
            .await
            .map_err(before)?;
        let native = self
            .helper_call(
                Some(operation_id),
                "observe",
                json!({"library":null,"limit":1}),
                cancellation.clone(),
            )
            .await?;
        if native["r_version"] != plan.r_version || native["platform"] != plan.platform {
            return Err(before("selected R runtime differs from the plan"));
        }
        let stage = self.stage("realizations", operation_id).map_err(before)?;
        let library = stage.join("library");
        std::fs::create_dir(&library).map_err(|e| before(e.to_string()))?;
        let recovery = EnvironmentStageRecovery {
            stage: stage.to_string_lossy().into_owned(),
            plan_operation_id: plan_id.into(),
            runtime: None,
            action: "inspect_staged_library_before_retry".into(),
        };
        let after =
            |error: String| HandlerError::after_possible_effect(error, Some(json!(recovery)));
        let with_stage = |mut error: HandlerError| {
            let mut stage = recovery.clone();
            stage.runtime = error
                .recovery
                .take()
                .map(serde_json::from_value)
                .transpose()
                .expect("Environment native errors use EnvironmentRuntimeRecovery");
            error.recovery = Some(json!(stage));
            error
        };
        let action = match plan.manager.as_str() {
            "pak" => "install_pak",
            "renv" => "install_renv",
            _ => return Err(before("unknown environment manager")),
        };
        self.helper_call(
            Some(operation_id),
            action,
            json!({"project":self.config.project_root,"library":library,"lockfile":lock}),
            cancellation.clone(),
        )
        .await
        .map_err(with_stage)?;
        self.check_sources(&plan.local_sources)
            .await
            .map_err(after)?;
        let library_path = library.to_string_lossy().into_owned();
        let observed = self
            .probes(
                operation_id,
                &library_path,
                &plan.packages,
                cancellation.clone(),
            )
            .await
            .map_err(with_stage)?;
        if observed.probes.len() != plan.packages.len()
            || observed.probes.iter().any(|probe| !probe.loadable)
        {
            return Err(after(format!(
                "namespace verification failed: {}",
                serde_json::to_string(&observed.probes).unwrap_or_default()
            )));
        }
        let renv_lock = stage.join("renv.lock");
        self.helper_call(
            Some(operation_id),
            "snapshot",
            json!({"project":stage,"library":library,"lockfile":renv_lock}),
            cancellation,
        )
        .await
        .map_err(with_stage)?;
        let library_digest = digest(&library).await.map_err(after)?;
        Ok(EnvironmentRealization {
            project_root: self.root.clone(),
            plan_operation_id: plan_id.into(),
            manager: plan.manager.clone(),
            lock_digest: plan.lock_digest.clone(),
            library_path,
            library_digest,
            renv_lockfile: renv_lock.to_string_lossy().into_owned(),
            r_version: observed.r_version,
            platform: observed.platform,
            packages: plan.packages.clone(),
            probes: observed.probes,
            verified: true,
            restart_required: true,
            activation: "available_not_active".into(),
        })
    }
    async fn verify(
        &self,
        operation_id: &str,
        receipt: &EnvironmentRealization,
        cancellation: watch::Receiver<bool>,
    ) -> Result<Verification, HandlerError> {
        if receipt.project_root != self.root {
            return Err(before("realization belongs to another project"));
        }
        let library = self.owned_path(&receipt.library_path).map_err(before)?;
        let digest_matches = digest(&library).await.map_err(before)? == receipt.library_digest;
        if !digest_matches {
            return Ok(Verification {
                verified: false,
                library_digest_matches: false,
                probes: Vec::new(),
                errors: vec!["managed library bytes changed after realization".into()],
            });
        }
        let observed = self
            .probes(
                operation_id,
                &receipt.library_path,
                &receipt.packages,
                cancellation,
            )
            .await?;
        let mut errors = Vec::new();
        if observed.r_version != receipt.r_version || observed.platform != receipt.platform {
            errors.push("R runtime differs from realization".into());
        }
        if observed.probes.len() != receipt.packages.len()
            || observed.probes.iter().any(|probe| !probe.loadable)
        {
            errors.push("namespace verification failed".into());
        }
        if digest(&library).await.map_err(uncertain)? != receipt.library_digest {
            errors.push("managed library changed during namespace verification".into());
        }
        Ok(Verification {
            verified: errors.is_empty(),
            library_digest_matches: digest_matches,
            probes: observed.probes,
            errors,
        })
    }
}

fn validate_package(package: &PackageVersion) -> Result<(), String> {
    if package.name.is_empty()
        || package.name.len() > 128
        || !package
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.')
        || package.version.is_empty()
        || package.version.len() > 80
        || !package
            .version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
    {
        return Err("native plan returned an invalid package identity".into());
    }
    Ok(())
}
fn response(path: &Path, id: &str) -> Result<Value, String> {
    let result: Response = serde_json::from_slice(&read_bounded(path)?).map_err(display)?;
    if result.protocol_version != 1 || result.request_id != id {
        return Err("Environment helper response identity mismatch".into());
    }
    if !result.ok {
        return Err(result
            .error
            .unwrap_or_else(|| "Environment helper failed".into()));
    }
    result
        .value
        .ok_or_else(|| "Environment helper returned no result".into())
}
fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(display)?
        .take(MAX_RESULT + 1)
        .read_to_end(&mut bytes)
        .map_err(display)?;
    if bytes.len() as u64 > MAX_RESULT {
        return Err("Environment document exceeds 4 MiB".into());
    }
    Ok(bytes)
}
async fn digest(root: &Path) -> Result<String, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || tree_digest(&root))
        .await
        .map_err(display)?
}
fn tree_digest(root: &Path) -> Result<String, String> {
    if root.is_file() {
        let mut input = std::fs::File::open(root).map_err(display)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 65536];
        let mut total = 0_u64;
        loop {
            let n = input.read(&mut buffer).map_err(display)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_TREE_BYTES {
                return Err("Environment source exceeds the digest bound".into());
            }
            hasher.update(&buffer[..n]);
        }
        return Ok(format!("sha256:{:x}", hasher.finalize()));
    }
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).map_err(display)? {
            let entry = entry.map_err(display)?;
            let path = entry.path();
            if entry.file_name() == ".git" {
                continue;
            }
            let kind = entry.file_type().map_err(display)?;
            if kind.is_symlink() {
                return Err("Environment source/library digest does not follow symlinks".into());
            }
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                files.push(path);
            }
            if files.len() + pending.len() > 200_000 {
                return Err("Environment file count exceeds the bound".into());
            }
        }
    }
    files.sort();
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 65536];
    for path in files {
        let name = path
            .strip_prefix(root)
            .map_err(display)?
            .to_str()
            .ok_or("Environment path is not UTF-8")?
            .replace('\\', "/");
        hasher.update((name.len() as u64).to_be_bytes());
        hasher.update(name.as_bytes());
        let mut content = Sha256::new();
        let mut input = std::fs::File::open(&path).map_err(display)?;
        loop {
            let n = input.read(&mut buffer).map_err(display)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_TREE_BYTES {
                return Err("Environment bytes exceed the digest bound".into());
            }
            content.update(&buffer[..n]);
        }
        hasher.update(content.finalize());
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn before(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::before_effect(error.to_string())
}
fn valid_marker(value: &str) -> bool {
    let Some((random, time)) = value.split_once('_') else {
        return false;
    };
    value.len() <= 200
        && random.starts_with("PS")
        && random.len() > 2
        && random.chars().all(|c| c.is_ascii_alphanumeric())
        && !time.is_empty()
        && time.chars().all(|c| c.is_ascii_digit())
}

fn uncertain(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::after_possible_effect(error.to_string(), None)
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    pub(super) fn environment() -> (TempDir, REnvironment) {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        // These tests exercise storage only; no R subprocess is started.
        let runtime = REnvironment::open(REnvironmentConfig {
            rscript: std::env::current_exe().unwrap(),
            project_root: project,
            data_root: dir.path().join("environment"),
            timeout: Duration::from_secs(1),
        })
        .unwrap();
        (dir, runtime)
    }

    #[test]
    fn marker_is_persistent_and_bound_to_operation_and_project() {
        let (_dir, runtime) = environment();
        let temporary = NamedTempFile::new_in(&runtime.config.data_root).unwrap();
        runtime
            .persist_marker(temporary, "op_test", "PSexample_1700000000")
            .unwrap();
        let saved = runtime.read_marker("op_test").unwrap().unwrap();
        assert_eq!(saved.marker, "PSexample_1700000000");
        assert!(runtime.read_marker("op_other").unwrap().is_none());
        let file = runtime.recovery_path("op_test").unwrap();
        let mut contents: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        contents["operation_id"] = json!("op_other");
        std::fs::write(&file, serde_json::to_vec(&contents).unwrap()).unwrap();
        assert!(
            runtime
                .read_marker("op_test")
                .unwrap_err()
                .contains("identity mismatch")
        );
        contents["operation_id"] = json!("op_test");
        contents["project_root"] = json!("another-project");
        std::fs::write(&file, serde_json::to_vec(&contents).unwrap()).unwrap();
        assert!(runtime.read_marker("op_test").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_directory_and_files_cannot_follow_symlinks() {
        let (dir, runtime) = environment();
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let recovery = runtime.config.data_root.join("recovery");
        std::os::unix::fs::symlink(&outside, &recovery).unwrap();
        let temporary = NamedTempFile::new_in(&runtime.config.data_root).unwrap();
        assert!(
            runtime
                .persist_marker(temporary, "op_test", "PSexample_1700000000")
                .is_err()
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        std::fs::remove_file(&recovery).unwrap();
        std::fs::create_dir(&recovery).unwrap();
        let file = runtime.recovery_path("op_test").unwrap();
        let target = outside.join("marker");
        std::fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(target, file).unwrap();
        assert!(runtime.read_marker("op_test").is_err());
    }
}
