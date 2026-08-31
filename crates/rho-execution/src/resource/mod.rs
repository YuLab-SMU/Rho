use std::collections::BTreeMap;

use rho_protocol::{ExecutionId, ProjectId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceRequest {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub max_processes: u32,
    pub walltime_ms: u64,
    pub disk_bytes: u64,
    pub output_bytes: u64,
    pub open_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourcePolicy {
    pub max_cpu_millis: u64,
    pub max_memory_bytes: u64,
    pub max_processes: u32,
    pub max_walltime_ms: u64,
    pub max_disk_bytes: u64,
    pub max_output_bytes: u64,
    pub max_open_files: u32,
    pub global_concurrency: usize,
    pub per_project_concurrency: usize,
}

impl Default for ResourcePolicy {
    fn default() -> Self {
        Self {
            max_cpu_millis: 60_000,
            max_memory_bytes: 2 * 1024 * 1024 * 1024,
            max_processes: 64,
            max_walltime_ms: 10 * 60 * 1000,
            max_disk_bytes: 1024 * 1024 * 1024,
            max_output_bytes: 256 * 1024 * 1024,
            max_open_files: 256,
            global_concurrency: 4,
            per_project_concurrency: 2,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ResourceGuarantee {
    Cpu,
    Memory,
    ProcessCount,
    Walltime,
    Disk,
    Output,
    OpenFiles,
    ProcessTree,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlatformResourceProfile {
    pub platform: String,
    pub adapter: String,
    pub enforced: Vec<ResourceGuarantee>,
    pub unsupported: Vec<ResourceGuarantee>,
    pub isolation_tier_enabled: bool,
}

impl PlatformResourceProfile {
    pub fn detect() -> Self {
        let required = all_guarantees();
        #[cfg(target_os = "linux")]
        let (adapter, enforced) = {
            let cgroup = std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists();
            let enforced = if cgroup {
                required.clone()
            } else {
                vec![
                    ResourceGuarantee::Walltime,
                    ResourceGuarantee::Disk,
                    ResourceGuarantee::Output,
                    ResourceGuarantee::ProcessTree,
                ]
            };
            ("linux-cgroup-v2-process-group".to_string(), enforced)
        };
        #[cfg(target_os = "macos")]
        let (adapter, enforced) = (
            "macos-process-group-observer-tier".to_string(),
            vec![
                ResourceGuarantee::Walltime,
                ResourceGuarantee::Disk,
                ResourceGuarantee::Output,
                ResourceGuarantee::ProcessTree,
            ],
        );
        #[cfg(target_os = "windows")]
        let (adapter, enforced) = (
            "windows-job-object".to_string(),
            vec![
                ResourceGuarantee::Memory,
                ResourceGuarantee::ProcessCount,
                ResourceGuarantee::Walltime,
                ResourceGuarantee::ProcessTree,
            ],
        );
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let (adapter, enforced) = ("unsupported".to_string(), Vec::new());
        let unsupported = required
            .iter()
            .copied()
            .filter(|guarantee| !enforced.contains(guarantee))
            .collect::<Vec<_>>();
        Self {
            platform: std::env::consts::OS.to_string(),
            adapter,
            enforced,
            isolation_tier_enabled: unsupported.is_empty(),
            unsupported,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EffectiveResourceAllocation {
    pub requested: ResourceRequest,
    pub effective: ResourceRequest,
    pub platform: PlatformResourceProfile,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ResourceAdmissionError {
    #[error("resource request exceeds policy: {0}")]
    RequestExceedsPolicy(&'static str),
    #[error("resource isolation tier is unavailable for required guarantees")]
    IsolationTierUnavailable,
    #[error("global execution concurrency quota reached")]
    GlobalConcurrency,
    #[error("project execution concurrency quota reached")]
    ProjectConcurrency,
    #[error("execution already owns a resource admission")]
    DuplicateExecution,
}

pub fn allocate_resources(
    request: ResourceRequest,
    policy: &ResourcePolicy,
    platform: PlatformResourceProfile,
    require_full_isolation: bool,
) -> Result<EffectiveResourceAllocation, ResourceAdmissionError> {
    for (name, exceeds) in [
        ("cpu", request.cpu_millis > policy.max_cpu_millis),
        ("memory", request.memory_bytes > policy.max_memory_bytes),
        ("pids", request.max_processes > policy.max_processes),
        ("walltime", request.walltime_ms > policy.max_walltime_ms),
        ("disk", request.disk_bytes > policy.max_disk_bytes),
        ("output", request.output_bytes > policy.max_output_bytes),
        ("open_files", request.open_files > policy.max_open_files),
    ] {
        if exceeds {
            return Err(ResourceAdmissionError::RequestExceedsPolicy(name));
        }
    }
    if require_full_isolation && !platform.isolation_tier_enabled {
        return Err(ResourceAdmissionError::IsolationTierUnavailable);
    }
    // No silent clamp: admitted effective values equal requested values.
    Ok(EffectiveResourceAllocation {
        effective: request.clone(),
        requested: request,
        platform,
    })
}

#[derive(Debug, Default)]
pub struct ResourceAdmissionController {
    active: BTreeMap<ExecutionId, ProjectId>,
}

impl ResourceAdmissionController {
    pub fn admit(
        &mut self,
        execution_id: ExecutionId,
        project_id: ProjectId,
        policy: &ResourcePolicy,
    ) -> Result<ResourceAdmissionToken, ResourceAdmissionError> {
        if self.active.contains_key(&execution_id) {
            return Err(ResourceAdmissionError::DuplicateExecution);
        }
        if self.active.len() >= policy.global_concurrency {
            return Err(ResourceAdmissionError::GlobalConcurrency);
        }
        if self
            .active
            .values()
            .filter(|active_project| *active_project == &project_id)
            .count()
            >= policy.per_project_concurrency
        {
            return Err(ResourceAdmissionError::ProjectConcurrency);
        }
        self.active.insert(execution_id.clone(), project_id.clone());
        Ok(ResourceAdmissionToken {
            execution_id,
            project_id,
        })
    }

    pub fn release(&mut self, token: ResourceAdmissionToken) -> bool {
        self.active
            .remove(&token.execution_id)
            .is_some_and(|project| project == token.project_id)
    }

    pub fn active_count(&self) -> usize {
        self.active.len()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceAdmissionToken {
    pub execution_id: ExecutionId,
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ObservedResourceUsage {
    pub cpu_millis: u64,
    pub peak_memory_bytes: u64,
    pub peak_processes: u32,
    pub walltime_ms: u64,
    pub disk_bytes: u64,
    pub output_bytes: u64,
    pub peak_open_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceTerminalReason {
    pub reason_code: String,
    pub violated: ResourceGuarantee,
    pub observed: ObservedResourceUsage,
}

pub fn observe_quota(
    allocation: &EffectiveResourceAllocation,
    observed: ObservedResourceUsage,
) -> Option<ResourceTerminalReason> {
    let limits = &allocation.effective;
    let violation = if observed.cpu_millis > limits.cpu_millis {
        Some(("cpu_quota_exceeded", ResourceGuarantee::Cpu))
    } else if observed.peak_memory_bytes > limits.memory_bytes {
        Some(("memory_quota_exceeded", ResourceGuarantee::Memory))
    } else if observed.peak_processes > limits.max_processes {
        Some(("process_quota_exceeded", ResourceGuarantee::ProcessCount))
    } else if observed.walltime_ms > limits.walltime_ms {
        Some(("walltime_quota_exceeded", ResourceGuarantee::Walltime))
    } else if observed.disk_bytes > limits.disk_bytes {
        Some(("disk_quota_exceeded", ResourceGuarantee::Disk))
    } else if observed.output_bytes > limits.output_bytes {
        Some(("output_quota_exceeded", ResourceGuarantee::Output))
    } else if observed.peak_open_files > limits.open_files {
        Some(("open_files_quota_exceeded", ResourceGuarantee::OpenFiles))
    } else {
        None
    }?;
    Some(ResourceTerminalReason {
        reason_code: violation.0.to_string(),
        violated: violation.1,
        observed,
    })
}

fn all_guarantees() -> Vec<ResourceGuarantee> {
    vec![
        ResourceGuarantee::Cpu,
        ResourceGuarantee::Memory,
        ResourceGuarantee::ProcessCount,
        ResourceGuarantee::Walltime,
        ResourceGuarantee::Disk,
        ResourceGuarantee::Output,
        ResourceGuarantee::OpenFiles,
        ResourceGuarantee::ProcessTree,
    ]
}

pub fn resource_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "request_admission",
            "effective_allocation",
            "global_project_concurrency",
            "observed_usage",
        ],
        &[
            "silent_clamp",
            "unsupported_tier_enable",
            "desktop_thread_block",
        ],
    )
}
