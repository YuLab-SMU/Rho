use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SandboxGuarantee {
    FilesystemIsolation,
    NetworkDeny,
    ProcessTreeControl,
    MemoryLimit,
    CpuLimit,
    ProcessLimit,
    HandleIsolation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlatformSandboxProfile {
    pub platform: String,
    pub adapter: String,
    pub guarantees: Vec<SandboxGuarantee>,
    pub unsupported: Vec<SandboxGuarantee>,
    pub mechanisms: BTreeMap<SandboxGuarantee, String>,
    pub external_mutation_enabled: bool,
    pub oci_enabled: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SandboxPlatformKind {
    Linux,
    MacOs,
    Windows,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlatformAttestation {
    pub platform: SandboxPlatformKind,
    pub mechanisms: BTreeMap<SandboxGuarantee, String>,
    pub oci_rootless_verified: bool,
    pub installer_permissions_verified: bool,
    pub source: String,
}

impl PlatformSandboxProfile {
    pub fn detect() -> Self {
        let required = required_mutation_guarantees();
        #[cfg(target_os = "linux")]
        let (adapter, guarantees) = {
            let bwrap = executable_on_path("bwrap");
            let cgroup = Path::new("/sys/fs/cgroup/cgroup.controllers").exists();
            let mut guarantees = vec![
                SandboxGuarantee::ProcessTreeControl,
                SandboxGuarantee::HandleIsolation,
            ];
            if bwrap {
                guarantees.extend([
                    SandboxGuarantee::FilesystemIsolation,
                    SandboxGuarantee::NetworkDeny,
                ]);
            }
            if cgroup {
                guarantees.extend([
                    SandboxGuarantee::MemoryLimit,
                    SandboxGuarantee::CpuLimit,
                    SandboxGuarantee::ProcessLimit,
                ]);
            }
            ("linux-bwrap-cgroup-v2".to_string(), guarantees)
        };
        #[cfg(target_os = "macos")]
        let (adapter, guarantees) = {
            let sandbox_exec = Path::new("/usr/bin/sandbox-exec").exists();
            let mut guarantees = vec![
                SandboxGuarantee::ProcessTreeControl,
                SandboxGuarantee::HandleIsolation,
            ];
            if sandbox_exec {
                guarantees.extend([
                    SandboxGuarantee::FilesystemIsolation,
                    SandboxGuarantee::NetworkDeny,
                ]);
            }
            ("macos-seatbelt-process-group".to_string(), guarantees)
        };
        #[cfg(target_os = "windows")]
        let (adapter, guarantees) = (
            "windows-restricted-token-job-object".to_string(),
            vec![
                SandboxGuarantee::ProcessTreeControl,
                SandboxGuarantee::HandleIsolation,
            ],
        );
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let (adapter, guarantees) = ("unsupported-platform".to_string(), Vec::new());

        let unsupported = required
            .iter()
            .copied()
            .filter(|guarantee| !guarantees.contains(guarantee))
            .collect::<Vec<_>>();
        let external_mutation_enabled = unsupported.is_empty();
        let mechanisms = guarantees
            .iter()
            .copied()
            .map(|guarantee| (guarantee, mechanism_name(guarantee, &adapter)))
            .collect();
        let oci_enabled = external_mutation_enabled
            && (executable_on_path("docker") || executable_on_path("podman"));
        Self {
            platform: std::env::consts::OS.to_string(),
            adapter,
            guarantees,
            unsupported: unsupported.clone(),
            mechanisms,
            external_mutation_enabled,
            oci_enabled,
            reason: if unsupported.is_empty() {
                "all external-mutation sandbox guarantees verified".to_string()
            } else {
                format!(
                    "external mutation disabled; unsupported guarantees: {}",
                    unsupported
                        .iter()
                        .map(|value| format!("{value:?}").to_ascii_lowercase())
                        .collect::<Vec<_>>()
                        .join(",")
                )
            },
        }
    }

    pub fn from_attestation(attestation: PlatformAttestation) -> Self {
        let required = required_mutation_guarantees();
        let guarantees = attestation.mechanisms.keys().copied().collect::<Vec<_>>();
        let unsupported = required
            .iter()
            .copied()
            .filter(|guarantee| !attestation.mechanisms.contains_key(guarantee))
            .collect::<Vec<_>>();
        let verified_source =
            !attestation.source.is_empty() && attestation.installer_permissions_verified;
        let external_mutation_enabled = unsupported.is_empty() && verified_source;
        let platform = match attestation.platform {
            SandboxPlatformKind::Linux => "linux",
            SandboxPlatformKind::MacOs => "macos",
            SandboxPlatformKind::Windows => "windows",
        }
        .to_string();
        Self {
            adapter: format!("{platform}-attested-profile"),
            platform,
            guarantees,
            unsupported: unsupported.clone(),
            mechanisms: attestation.mechanisms,
            external_mutation_enabled,
            oci_enabled: external_mutation_enabled && attestation.oci_rootless_verified,
            reason: if external_mutation_enabled {
                "all guarantees and installer permissions verified by a target-host attestation"
                    .to_string()
            } else {
                format!(
                    "external mutation disabled; attestation incomplete or unsupported: {}",
                    unsupported
                        .iter()
                        .map(|value| format!("{value:?}").to_ascii_lowercase())
                        .collect::<Vec<_>>()
                        .join(",")
                )
            },
        }
    }

    pub fn advertised_capabilities(&self) -> Vec<&'static str> {
        let mut capabilities = vec!["external_observer"];
        if self.external_mutation_enabled {
            capabilities.push("controlled_external_mutation");
        }
        if self.oci_enabled {
            capabilities.push("oci_execution");
        }
        capabilities
    }
}

pub fn required_mutation_guarantees() -> Vec<SandboxGuarantee> {
    vec![
        SandboxGuarantee::FilesystemIsolation,
        SandboxGuarantee::NetworkDeny,
        SandboxGuarantee::ProcessTreeControl,
        SandboxGuarantee::MemoryLimit,
        SandboxGuarantee::CpuLimit,
        SandboxGuarantee::ProcessLimit,
        SandboxGuarantee::HandleIsolation,
    ]
}

fn executable_on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .map(|directory| directory.join(name))
                .any(|candidate| candidate.is_file())
        })
        .unwrap_or(false)
}

fn mechanism_name(guarantee: SandboxGuarantee, adapter: &str) -> String {
    let mechanism = match guarantee {
        SandboxGuarantee::FilesystemIsolation => "read-only snapshot namespace/seatbelt",
        SandboxGuarantee::NetworkDeny => "network namespace/seatbelt deny",
        SandboxGuarantee::ProcessTreeControl => "process group/job object",
        SandboxGuarantee::MemoryLimit => "cgroup/job object memory",
        SandboxGuarantee::CpuLimit => "cgroup/job object CPU",
        SandboxGuarantee::ProcessLimit => "cgroup pids/job object process limit",
        SandboxGuarantee::HandleIsolation => "close-on-exec/restricted handle inheritance",
    };
    format!("{adapter}:{mechanism}")
}

pub fn platform_wrapper(
    profile: &PlatformSandboxProfile,
    _root: &Path,
) -> Option<(PathBuf, Vec<String>)> {
    if !profile.external_mutation_enabled {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        if profile.adapter.starts_with("linux-bwrap") {
            return Some((
                PathBuf::from("bwrap"),
                vec![
                    "--unshare-all".to_string(),
                    "--die-with-parent".to_string(),
                    "--ro-bind".to_string(),
                    _root.join("workspace").display().to_string(),
                    "/workspace".to_string(),
                    "--bind".to_string(),
                    _root.join("scratch").display().to_string(),
                    "/scratch".to_string(),
                    "--bind".to_string(),
                    _root.join("staging").display().to_string(),
                    "/staging".to_string(),
                ],
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/usr/bin/sandbox-exec").exists() {
            return Some((
                PathBuf::from("/usr/bin/sandbox-exec"),
                vec!["-p".to_string(), "(version 1) (deny default)".to_string()],
            ));
        }
    }
    None
}
