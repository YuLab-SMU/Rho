use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallPackageKind {
    Provider,
    Runner,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum DeclaredPermission {
    ModelNetwork,
    ReadSnapshot,
    ReadArtifact,
    ControlledMutation,
    RemoteExecution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignedInstallMetadata {
    pub package_id: String,
    pub kind: InstallPackageKind,
    pub version: String,
    pub channel: String,
    pub source_origin: String,
    pub byte_size: u64,
    pub sha256: String,
    pub signature: String,
    pub protocol_version: u16,
    pub capability_tier: String,
    pub permissions: BTreeSet<DeclaredPermission>,
}

pub trait PackageSignatureVerifier {
    fn verify(&self, signed_bytes: &[u8], signature: &str) -> bool;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExplicitInstallRequest {
    pub package_id: String,
    pub expected_source_origin: String,
    pub expected_channel: String,
    pub acknowledge_permissions: BTreeSet<DeclaredPermission>,
    pub enable_after_install: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StagedInstall {
    pub package_id: String,
    pub version: String,
    pub digest: String,
    pub protocol_version: u16,
    pub candidate_path: PathBuf,
    pub enable_requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallAuditRecord {
    pub package_id: String,
    pub version: String,
    pub digest: String,
    pub action: String,
    pub result: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallFaultPoint {
    AfterTempWrite,
    BeforeRename,
    AfterRename,
    BeforeActivationPointer,
}

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("install request is not explicit or permission acknowledgement differs")]
    NotExplicit,
    #[error("release metadata source/channel/package/version is invalid")]
    InvalidMetadata,
    #[error("release signature verification failed")]
    Signature,
    #[error("package is truncated, oversized, or digest mismatched")]
    Digest,
    #[error("package version rollback is rejected")]
    Rollback,
    #[error("runner/provider protocol is incompatible")]
    IncompatibleProtocol,
    #[error("running jobs prevent runner activation")]
    RunningJobs,
    #[error("install IO failed")]
    Io(#[from] std::io::Error),
    #[error("install fault injected")]
    FaultInjected,
}

pub struct ExplicitPackageInstaller<V> {
    root: PathBuf,
    verifier: V,
    audit: Vec<InstallAuditRecord>,
}

impl<V: PackageSignatureVerifier> ExplicitPackageInstaller<V> {
    pub fn open(root: impl AsRef<Path>, verifier: V) -> Result<Self, InstallError> {
        fs::create_dir_all(root.as_ref())?;
        let root = root.as_ref().canonicalize()?;
        Ok(Self {
            root,
            verifier,
            audit: Vec::new(),
        })
    }

    pub fn stage(
        &mut self,
        request: &ExplicitInstallRequest,
        metadata: &SignedInstallMetadata,
        bytes: &[u8],
    ) -> Result<StagedInstall, InstallError> {
        self.stage_with_fault(request, metadata, bytes, None)
    }

    pub fn stage_with_fault(
        &mut self,
        request: &ExplicitInstallRequest,
        metadata: &SignedInstallMetadata,
        bytes: &[u8],
        fault: Option<InstallFaultPoint>,
    ) -> Result<StagedInstall, InstallError> {
        validate_request(request, metadata)?;
        let signed_bytes = install_signing_payload(metadata)?;
        if !self.verifier.verify(&signed_bytes, &metadata.signature) {
            return Err(InstallError::Signature);
        }
        if bytes.len() as u64 != metadata.byte_size || digest(bytes) != metadata.sha256 {
            return Err(InstallError::Digest);
        }
        if let Some(active) = self.active_version(&metadata.package_id)?
            && Version::parse(&metadata.version).map_err(|_| InstallError::InvalidMetadata)?
                <= Version::parse(&active).map_err(|_| InstallError::InvalidMetadata)?
        {
            return Err(InstallError::Rollback);
        }
        let package_root = self.root.join(&metadata.package_id);
        fs::create_dir_all(&package_root)?;
        let candidate = package_root.join(&metadata.version);
        if candidate.exists() {
            let package = candidate.join("package.bin");
            let persisted = candidate.join("metadata.json");
            if package.exists()
                && persisted.exists()
                && digest(&fs::read(&package)?) == metadata.sha256
            {
                let persisted_metadata: SignedInstallMetadata =
                    serde_json::from_slice(&fs::read(persisted)?)
                        .map_err(|_| InstallError::InvalidMetadata)?;
                if persisted_metadata == *metadata {
                    return Ok(StagedInstall {
                        package_id: metadata.package_id.clone(),
                        version: metadata.version.clone(),
                        digest: metadata.sha256.clone(),
                        protocol_version: metadata.protocol_version,
                        candidate_path: candidate,
                        enable_requested: request.enable_after_install,
                    });
                }
            }
            return Err(InstallError::Rollback);
        }
        let temp = package_root.join(format!(".{}.installing", metadata.version));
        {
            let mut file = File::create(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        if fault == Some(InstallFaultPoint::AfterTempWrite) {
            return Err(InstallError::FaultInjected);
        }
        if fault == Some(InstallFaultPoint::BeforeRename) {
            return Err(InstallError::FaultInjected);
        }
        fs::create_dir(&candidate)?;
        fs::rename(&temp, candidate.join("package.bin"))?;
        write_metadata(&candidate, metadata)?;
        File::open(&candidate)?.sync_all()?;
        File::open(&package_root)?.sync_all()?;
        if fault == Some(InstallFaultPoint::AfterRename) {
            return Err(InstallError::FaultInjected);
        }
        let staged = StagedInstall {
            package_id: metadata.package_id.clone(),
            version: metadata.version.clone(),
            digest: metadata.sha256.clone(),
            protocol_version: metadata.protocol_version,
            candidate_path: candidate,
            enable_requested: request.enable_after_install,
        };
        self.audit.push(InstallAuditRecord {
            package_id: metadata.package_id.clone(),
            version: metadata.version.clone(),
            digest: metadata.sha256.clone(),
            action: "stage".to_string(),
            result: "verified".to_string(),
        });
        Ok(staged)
    }

    pub fn activate(
        &mut self,
        staged: &StagedInstall,
        expected_protocol: u16,
        running_jobs: usize,
        fault: Option<InstallFaultPoint>,
    ) -> Result<(), InstallError> {
        if staged.protocol_version != expected_protocol {
            return Err(InstallError::IncompatibleProtocol);
        }
        if running_jobs > 0 {
            return Err(InstallError::RunningJobs);
        }
        let package_root = self.root.join(&staged.package_id);
        let candidate = staged.candidate_path.canonicalize()?;
        if !candidate.starts_with(&package_root)
            || digest(&fs::read(candidate.join("package.bin"))?) != staged.digest
        {
            return Err(InstallError::Digest);
        }
        if fault == Some(InstallFaultPoint::BeforeActivationPointer) {
            return Err(InstallError::FaultInjected);
        }
        let active_temp = package_root.join("active.tmp");
        {
            let mut file = File::create(&active_temp)?;
            file.write_all(staged.version.as_bytes())?;
            file.sync_all()?;
        }
        fs::rename(active_temp, package_root.join("active"))?;
        File::open(&package_root)?.sync_all()?;
        self.audit.push(InstallAuditRecord {
            package_id: staged.package_id.clone(),
            version: staged.version.clone(),
            digest: staged.digest.clone(),
            action: "activate".to_string(),
            result: "active".to_string(),
        });
        Ok(())
    }

    pub fn active_version(&self, package_id: &str) -> Result<Option<String>, InstallError> {
        let path = self.root.join(package_id).join("active");
        match fs::read_to_string(path) {
            Ok(value) => Ok(Some(value.trim().to_string())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn audit(&self) -> &[InstallAuditRecord] {
        &self.audit
    }
}

fn validate_request(
    request: &ExplicitInstallRequest,
    metadata: &SignedInstallMetadata,
) -> Result<(), InstallError> {
    if request.package_id != metadata.package_id
        || request.expected_source_origin != metadata.source_origin
        || request.expected_channel != metadata.channel
        || request.acknowledge_permissions != metadata.permissions
    {
        return Err(InstallError::NotExplicit);
    }
    if metadata.package_id.is_empty()
        || !metadata
            .package_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        || Version::parse(&metadata.version).is_err()
        || !matches!(metadata.channel.as_str(), "stable" | "beta" | "development")
        || !metadata.source_origin.starts_with("https://")
        || !valid_digest(&metadata.sha256)
        || metadata.byte_size == 0
        || metadata.byte_size > 512 * 1024 * 1024
        || metadata.signature.is_empty()
        || metadata.capability_tier.is_empty()
    {
        return Err(InstallError::InvalidMetadata);
    }
    Ok(())
}

pub fn install_signing_payload(metadata: &SignedInstallMetadata) -> Result<Vec<u8>, InstallError> {
    let value = serde_json::json!({
        "package_id": metadata.package_id,
        "kind": metadata.kind,
        "version": metadata.version,
        "channel": metadata.channel,
        "source_origin": metadata.source_origin,
        "byte_size": metadata.byte_size,
        "sha256": metadata.sha256,
        "protocol_version": metadata.protocol_version,
        "capability_tier": metadata.capability_tier,
        "permissions": metadata.permissions,
    });
    serde_json::to_vec(&value).map_err(|_| InstallError::InvalidMetadata)
}

fn write_metadata(path: &Path, metadata: &SignedInstallMetadata) -> Result<(), InstallError> {
    let temp = path.join("metadata.json.tmp");
    let final_path = path.join("metadata.json");
    let mut file = File::create(&temp)?;
    file.write_all(&serde_json::to_vec(metadata).map_err(|_| InstallError::InvalidMetadata)?)?;
    file.sync_all()?;
    fs::rename(temp, final_path)?;
    Ok(())
}

pub fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.chars().all(|character| character.is_ascii_hexdigit())
    })
}

pub fn install_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "explicit_request",
            "signed_metadata",
            "digest_size_version",
            "atomic_stage_activate",
            "running_job_compatibility",
        ],
        &[
            "automatic_registry_download",
            "unverified_execution",
            "plaintext_install_log",
            "partial_active_install",
            "running_job_disruption",
        ],
    )
}
