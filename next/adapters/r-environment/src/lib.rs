#![forbid(unsafe_code)]

use async_trait::async_trait;
use rho_next_environment::{
    EnvironmentPlan, EnvironmentRealization, EnvironmentRuntime, NamespaceProbe, PackageVersion,
    PlanArguments, SourceDigest, Verification,
};
use rho_next_operation::HandlerError;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tempfile::{NamedTempFile, TempDir};
use tokio::io::{AsyncRead, AsyncReadExt};

const HELPER: &str = include_str!("../../../r/environment/helper.R");
const VERIFY: &str = include_str!("../../../r/environment/verify.R");
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
        std::fs::write(helper.path(), HELPER).map_err(display)?;
        std::fs::write(verifier.path(), VERIFY).map_err(display)?;
        Ok(Self {
            root: config.project_root.to_string_lossy().into_owned(),
            config,
            helper,
            verifier,
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
    async fn helper_call(&self, id: &str, action: &str, payload: Value) -> Result<Value, String> {
        let scratch = TempDir::new_in(&self.config.data_root).map_err(display)?;
        let input = scratch.path().join("request.json");
        let output = scratch.path().join("result.json");
        std::fs::write(
            &input,
            serde_json::to_vec(
                &json!({"protocol_version":1,"request_id":id,"action":action,"payload":payload}),
            )
            .map_err(display)?,
        )
        .map_err(display)?;
        self.run(
            self.helper.path(),
            &[
                input.to_string_lossy().into_owned(),
                output.to_string_lossy().into_owned(),
            ],
        )
        .await?;
        response(&output, id)
    }
    async fn run(&self, script: &Path, args: &[String]) -> Result<(), String> {
        let mut command = tokio::process::Command::new(&self.config.rscript);
        command
            .arg("--vanilla")
            .arg(script)
            .args(args)
            .current_dir(&self.config.project_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
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
        let mut child = command.spawn().map_err(display)?;
        let stdout = child.stdout.take().ok_or("R helper stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("R helper stderr unavailable")?;
        let result = tokio::time::timeout(self.config.timeout, async {
            let (status, out, err) = tokio::join!(child.wait(), bounded(stdout), bounded(stderr));
            let status = status.map_err(display)?;
            let out = out?;
            let err = err?;
            if !status.success() {
                return Err(format!(
                    "R helper exited {:?}: {} {}",
                    status.code(),
                    String::from_utf8_lossy(&out)
                        .chars()
                        .take(4000)
                        .collect::<String>(),
                    String::from_utf8_lossy(&err)
                        .chars()
                        .take(4000)
                        .collect::<String>()
                ));
            }
            Ok(())
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err("R helper timed out; staged effects may exist".into())
            }
        }
    }
    async fn probes(
        &self,
        id: &str,
        library: &str,
        packages: &[PackageVersion],
    ) -> Result<NativeVerification, String> {
        let native = self
            .helper_call("support", "observe", json!({"library":null,"limit":1}))
            .await?;
        let support = native["jsonlite_library"]
            .as_str()
            .ok_or("jsonlite support library unavailable")?;
        let scratch = TempDir::new_in(&self.config.data_root).map_err(display)?;
        let output = scratch.path().join("verify.json");
        let mut args = vec![
            library.into(),
            support.into(),
            output.to_string_lossy().into_owned(),
            id.into(),
        ];
        for package in packages {
            validate_package(package)?;
            args.push(format!("{}@{}", package.name, package.version));
        }
        self.run(self.verifier.path(), &args).await?;
        serde_json::from_value(response(&output, id)?).map_err(display)
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
    async fn observe(&self, library: Option<&str>, limit: usize) -> Result<Value, String> {
        if !(1..=500).contains(&limit) {
            return Err("Environment observation limit is invalid".into());
        }
        let library = library.map(|path| self.owned_path(path)).transpose()?;
        self.helper_call(
            "observe",
            "observe",
            json!({"library":library,"limit":limit}),
        )
        .await
    }
    async fn plan(
        &self,
        operation_id: &str,
        args: &PlanArguments,
    ) -> Result<EnvironmentPlan, String> {
        let stage = self.stage("plans", operation_id)?;
        let lock_path = stage.join("source.lock");
        let library = stage.join("empty-library");
        std::fs::create_dir(&library).map_err(display)?;
        let mut inputs = BTreeSet::new();
        let (manager, native) = match args {
            PlanArguments::Pak { packages } => {
                let mut normalized = Vec::new();
                for package in packages {
                    let mut reference = package.clone();
                    for prefix in ["local::", "deps::"] {
                        if let Some(path) = package.strip_prefix(prefix) {
                            let path = self.source_path(path)?;
                            inputs.insert(path.clone());
                            reference = format!("{prefix}{}", path.to_string_lossy());
                        }
                    }
                    normalized.push(reference);
                }
                (
                    "pak",
                    self.helper_call(
                        operation_id,
                        "plan_pak",
                        json!({"packages":normalized,"lockfile":lock_path,"library":library}),
                    )
                    .await?,
                )
            }
            PlanArguments::Renv { lockfile } => {
                let source = self.source_path(lockfile)?;
                let bytes = read_bounded(&source)?;
                let mut lock: Value = serde_json::from_slice(&bytes).map_err(display)?;
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
                            record["Path"] = json!(self.source_path(&path)?);
                        }
                    }
                }
                std::fs::write(
                    &lock_path,
                    serde_json::to_vec_pretty(&lock).map_err(display)?,
                )
                .map_err(display)?;
                (
                    "renv",
                    self.helper_call(operation_id, "plan_renv", json!({"lockfile":lock_path}))
                        .await?,
                )
            }
        };
        let native: NativePlan = serde_json::from_value(native).map_err(display)?;
        if native.packages.len() > 512 {
            return Err("Environment plan exceeds 512 packages".into());
        }
        let mut names = BTreeSet::new();
        for package in &native.packages {
            validate_package(package)?;
            if !names.insert(&package.name) {
                return Err("duplicate package in native lockfile".into());
            }
        }
        for path in &native.local_sources {
            inputs.insert(self.source_path(path)?);
        }
        let mut local_sources = Vec::new();
        for path in inputs {
            local_sources.push(SourceDigest {
                sha256: digest(&path).await?,
                path: path.to_string_lossy().into_owned(),
            });
        }
        Ok(EnvironmentPlan {
            project_root: self.root.clone(),
            manager: manager.into(),
            lock_digest: hash(&read_bounded(&lock_path)?),
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
        let native = self.observe(None, 1).await.map_err(before)?;
        if native["r_version"] != plan.r_version || native["platform"] != plan.platform {
            return Err(before("selected R runtime differs from the plan"));
        }
        let stage = self.stage("realizations", operation_id).map_err(before)?;
        let library = stage.join("library");
        std::fs::create_dir(&library).map_err(|e| before(e.to_string()))?;
        let recovery = json!({"stage":stage,"plan_operation_id":plan_id,"action":"inspect_staged_library_before_retry"});
        let after =
            |error: String| HandlerError::after_possible_effect(error, Some(recovery.clone()));
        let action = match plan.manager.as_str() {
            "pak" => "install_pak",
            "renv" => "install_renv",
            _ => return Err(before("unknown environment manager")),
        };
        self.helper_call(
            operation_id,
            action,
            json!({"project":self.config.project_root,"library":library,"lockfile":lock}),
        )
        .await
        .map_err(after)?;
        self.check_sources(&plan.local_sources)
            .await
            .map_err(after)?;
        let library_path = library.to_string_lossy().into_owned();
        let observed = self
            .probes(operation_id, &library_path, &plan.packages)
            .await
            .map_err(after)?;
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
            operation_id,
            "snapshot",
            json!({"project":stage,"library":library,"lockfile":renv_lock}),
        )
        .await
        .map_err(after)?;
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
    async fn verify(&self, receipt: &EnvironmentRealization) -> Result<Verification, String> {
        if receipt.project_root != self.root {
            return Err("realization belongs to another project".into());
        }
        let library = self.owned_path(&receipt.library_path)?;
        let digest_matches = digest(&library).await? == receipt.library_digest;
        if !digest_matches {
            return Ok(Verification {
                verified: false,
                library_digest_matches: false,
                probes: Vec::new(),
                errors: vec!["managed library bytes changed after realization".into()],
            });
        }
        let observed = self
            .probes("verify", &receipt.library_path, &receipt.packages)
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
        if digest(&library).await? != receipt.library_digest {
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
async fn bounded(input: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    input
        .take(MAX_RESULT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(display)?;
    if bytes.len() as u64 > MAX_RESULT {
        return Err("R helper output exceeds 4 MiB".into());
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
fn before(error: impl Into<String>) -> HandlerError {
    HandlerError::before_effect(error)
}
