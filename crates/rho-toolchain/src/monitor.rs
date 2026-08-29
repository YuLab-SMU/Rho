use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::{Disks, MINIMUM_CPU_UPDATE_INTERVAL, System};

use crate::{
    ComputeHost, ComputeIsolation, ComputeTarget, RemoteHelperOperation, RemoteHelperRequest,
    TargetRegistryDocument, ToolchainError, invoke_remote_helper, load_toolchain_config,
};

const MONITOR_SCHEMA_VERSION: u16 = 1;
const MAX_MONITORED_TARGETS: usize = 16;
const MAX_GPU_DEVICES: usize = 32;
const MAX_COMMAND_OUTPUT_BYTES: u64 = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const CPU_WARNING_BPS: u16 = 8_500;
const CPU_CRITICAL_BPS: u16 = 9_500;
const MEMORY_AVAILABLE_WARNING_BPS: u16 = 2_000;
const MEMORY_AVAILABLE_CRITICAL_BPS: u16 = 1_000;
const DISK_AVAILABLE_WARNING_BPS: u16 = 1_500;
const DISK_AVAILABLE_CRITICAL_BPS: u16 = 500;
const GPU_WARNING_BPS: u16 = 9_000;
const GPU_CRITICAL_BPS: u16 = 9_800;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourcePressure {
    Healthy,
    Warning,
    Critical,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceMetricSnapshot {
    pub resource_id: String,
    pub kind: String,
    pub label: String,
    pub unit: String,
    pub capacity: Option<u64>,
    pub available: Option<u64>,
    pub utilization_basis_points: Option<u16>,
    pub pressure: ResourcePressure,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceResourceSnapshot {
    pub schema_version: u16,
    pub device_id: String,
    pub host_name: String,
    pub operating_system: String,
    pub architecture: String,
    pub observed_at: String,
    pub cpu_logical_count: usize,
    pub metrics: Vec<ResourceMetricSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceGovernanceThresholds {
    pub cpu_warning_basis_points: u16,
    pub cpu_critical_basis_points: u16,
    pub memory_available_warning_basis_points: u16,
    pub memory_available_critical_basis_points: u16,
    pub disk_available_warning_basis_points: u16,
    pub disk_available_critical_basis_points: u16,
    pub gpu_warning_basis_points: u16,
    pub gpu_critical_basis_points: u16,
}

impl Default for ResourceGovernanceThresholds {
    fn default() -> Self {
        Self {
            cpu_warning_basis_points: CPU_WARNING_BPS,
            cpu_critical_basis_points: CPU_CRITICAL_BPS,
            memory_available_warning_basis_points: MEMORY_AVAILABLE_WARNING_BPS,
            memory_available_critical_basis_points: MEMORY_AVAILABLE_CRITICAL_BPS,
            disk_available_warning_basis_points: DISK_AVAILABLE_WARNING_BPS,
            disk_available_critical_basis_points: DISK_AVAILABLE_CRITICAL_BPS,
            gpu_warning_basis_points: GPU_WARNING_BPS,
            gpu_critical_basis_points: GPU_CRITICAL_BPS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetResourceSnapshot {
    pub target_id: String,
    pub selected: bool,
    pub host_kind: String,
    pub isolation_kind: String,
    pub environment_identity: String,
    pub capabilities: Vec<String>,
    pub status: ResourcePressure,
    pub admission_allowed: bool,
    pub governance_reasons: Vec<String>,
    pub device: Option<DeviceResourceSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceMonitorSnapshot {
    pub schema_version: u16,
    pub project_root: PathBuf,
    pub rho_toml_sha256: Option<String>,
    pub target_registry_sha256: Option<String>,
    pub selected_target_id: String,
    pub observed_at: String,
    pub status: ResourcePressure,
    pub thresholds: ResourceGovernanceThresholds,
    pub targets: Vec<TargetResourceSnapshot>,
    pub total_targets: usize,
    pub truncated: bool,
}

pub fn inspect_local_resources(
    project_root: &Path,
) -> Result<DeviceResourceSnapshot, ToolchainError> {
    let project_root = project_root.canonicalize()?;
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_usage();
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();

    let host_name = bounded_label(
        System::host_name().as_deref().unwrap_or("unknown-device"),
        128,
    );
    let device_id = stable_device_id(&host_name);
    let cpu_usage = percent_basis_points(system.global_cpu_usage());
    let mut metrics = vec![ResourceMetricSnapshot {
        resource_id: format!("{device_id}:cpu"),
        kind: "cpu".to_string(),
        label: "CPU".to_string(),
        unit: "percent".to_string(),
        capacity: Some(system.cpus().len() as u64),
        available: None,
        utilization_basis_points: Some(cpu_usage),
        pressure: high_usage_pressure(cpu_usage, CPU_WARNING_BPS, CPU_CRITICAL_BPS),
        detail: format!("{} logical processors", system.cpus().len()),
    }];

    let total_memory = system.total_memory();
    let available_memory = system.available_memory().min(total_memory);
    metrics.push(capacity_metric(
        &device_id,
        "memory",
        "Memory",
        total_memory,
        available_memory,
        MEMORY_AVAILABLE_WARNING_BPS,
        MEMORY_AVAILABLE_CRITICAL_BPS,
    ));

    let disks = Disks::new_with_refreshed_list();
    if let Some(disk) = disks
        .list()
        .iter()
        .filter(|disk| project_root.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
    {
        metrics.push(capacity_metric(
            &device_id,
            "disk",
            "Project disk",
            disk.total_space(),
            disk.available_space().min(disk.total_space()),
            DISK_AVAILABLE_WARNING_BPS,
            DISK_AVAILABLE_CRITICAL_BPS,
        ));
    } else {
        metrics.push(unavailable_metric(
            &device_id,
            "disk",
            "Project disk",
            "No containing filesystem was reported",
        ));
    }

    metrics.extend(inspect_nvidia_gpus(&device_id));
    Ok(DeviceResourceSnapshot {
        schema_version: MONITOR_SCHEMA_VERSION,
        device_id,
        host_name,
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        observed_at: Utc::now().to_rfc3339(),
        cpu_logical_count: system.cpus().len(),
        metrics,
    })
}

pub fn monitor_target_resource(
    project_root: &Path,
    targets: &TargetRegistryDocument,
    target_id: &str,
) -> Result<TargetResourceSnapshot, ToolchainError> {
    let project_root = project_root.canonicalize()?;
    let config = load_toolchain_config(&project_root)?;
    let target = targets.registry.resolve(target_id)?;
    let gpu_required = target_requires_gpu(Some(&config), target_id);
    if matches!(target.host, ComputeHost::Local) {
        return Ok(target_snapshot(
            target_id,
            target,
            target_id,
            gpu_required,
            inspect_local_resources(&project_root).map_err(|error| error.to_string()),
        ));
    }
    let registry_sha256 = targets.sha256.as_deref().ok_or_else(|| {
        ToolchainError::InvalidTarget(
            "remote resource monitoring requires a targets.yaml digest".to_string(),
        )
    })?;
    Ok(inspect_remote_target(
        target_id,
        target,
        target_id,
        &config.sha256,
        registry_sha256,
        gpu_required,
    ))
}

pub fn monitor_project_resources(
    project_root: &Path,
    targets: &TargetRegistryDocument,
) -> Result<ResourceMonitorSnapshot, ToolchainError> {
    let project_root = project_root.canonicalize()?;
    let config = match load_toolchain_config(&project_root) {
        Ok(config) => Some(config),
        Err(ToolchainError::MissingConfig(_)) => None,
        Err(error) => return Err(error),
    };
    let selected_target_id = config
        .as_ref()
        .map_or(crate::LOCAL_TARGET_ID, |config| {
            config.config.compute.default_target.as_str()
        })
        .to_string();
    let selected_missing = !targets.registry.targets.contains_key(&selected_target_id);
    let mut target_ids = Vec::new();
    for target_id in [selected_target_id.as_str(), crate::LOCAL_TARGET_ID] {
        if targets.registry.targets.contains_key(target_id)
            && !target_ids.iter().any(|existing| existing == target_id)
        {
            target_ids.push(target_id.to_string());
        }
    }
    for target_id in targets.registry.targets.keys() {
        if target_ids.len() + usize::from(selected_missing) == MAX_MONITORED_TARGETS {
            break;
        }
        if !target_ids.contains(target_id) {
            target_ids.push(target_id.clone());
        }
    }
    let total_targets = targets.registry.targets.len() + usize::from(selected_missing);
    let local_device = inspect_local_resources(&project_root).map_err(|error| error.to_string());
    let mut snapshots = Vec::with_capacity(target_ids.len() + usize::from(selected_missing));
    if selected_missing {
        let mut missing = unavailable_target(
            &selected_target_id,
            None,
            "Configured target is missing from targets.yaml",
        );
        missing.selected = true;
        snapshots.push(missing);
    }
    let mut remote = Vec::new();
    for target_id in target_ids {
        let target = targets.registry.resolve(&target_id)?.clone();
        if matches!(target.host, ComputeHost::Local) {
            snapshots.push(target_snapshot(
                &target_id,
                &target,
                &selected_target_id,
                target_requires_gpu(config.as_ref(), &target_id),
                local_device.clone(),
            ));
        } else {
            let gpu_required = target_requires_gpu(config.as_ref(), &target_id);
            remote.push((target_id, target, gpu_required));
        }
    }

    if !remote.is_empty() {
        if let (Some(config), Some(registry_sha256)) = (config.as_ref(), targets.sha256.as_deref())
        {
            let mut remote_snapshots = std::thread::scope(|scope| {
                remote
                    .into_iter()
                    .map(|(target_id, target, gpu_required)| {
                        let selected_target_id = &selected_target_id;
                        let rho_toml_sha256 = &config.sha256;
                        scope.spawn(move || {
                            inspect_remote_target(
                                &target_id,
                                &target,
                                selected_target_id,
                                rho_toml_sha256,
                                registry_sha256,
                                gpu_required,
                            )
                        })
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .map(|handle| {
                        handle.join().unwrap_or_else(|_| {
                            unavailable_target(
                                "unknown",
                                None,
                                "Remote resource monitor worker panicked",
                            )
                        })
                    })
                    .collect::<Vec<_>>()
            });
            snapshots.append(&mut remote_snapshots);
        } else {
            snapshots.extend(remote.into_iter().map(|(target_id, target, _)| {
                unavailable_target(
                    &target_id,
                    Some((&target, target_id == selected_target_id)),
                    "Remote monitoring requires a managed rho.toml and targets.yaml digest",
                )
            }));
        }
    }
    snapshots.sort_by(|left, right| {
        right
            .selected
            .cmp(&left.selected)
            .then_with(|| left.target_id.cmp(&right.target_id))
    });
    let status = snapshots
        .iter()
        .map(|target| target.status)
        .max()
        .unwrap_or(ResourcePressure::Unavailable);
    Ok(ResourceMonitorSnapshot {
        schema_version: MONITOR_SCHEMA_VERSION,
        project_root,
        rho_toml_sha256: config.map(|config| config.sha256),
        target_registry_sha256: targets.sha256.clone(),
        selected_target_id,
        observed_at: Utc::now().to_rfc3339(),
        status,
        thresholds: ResourceGovernanceThresholds::default(),
        targets: snapshots,
        total_targets,
        truncated: total_targets > MAX_MONITORED_TARGETS,
    })
}

fn inspect_remote_target(
    target_id: &str,
    target: &ComputeTarget,
    selected_target_id: &str,
    rho_toml_sha256: &str,
    target_registry_sha256: &str,
    gpu_required: bool,
) -> TargetResourceSnapshot {
    let ComputeHost::Ssh { remote_root, .. } = &target.host else {
        return unavailable_target(
            target_id,
            Some((target, target_id == selected_target_id)),
            "Target is not remote",
        );
    };
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{target_id}:{rho_toml_sha256}:resources"))
    );
    let request = RemoteHelperRequest {
        protocol: 1,
        request_id: format!("resources-{}", &digest[..24]),
        target_id: target_id.to_string(),
        project_root: remote_root.clone(),
        rho_toml_sha256: rho_toml_sha256.to_string(),
        target_registry_sha256: target_registry_sha256.to_string(),
        operation: RemoteHelperOperation::InspectResources,
        payload: serde_json::json!({}),
    };
    match invoke_remote_helper(target_id, target, &request) {
        Ok(response) if response.ok && !response.partial_effects_possible => {
            match serde_json::from_value::<DeviceResourceSnapshot>(response.payload) {
                Ok(device) if device.schema_version == MONITOR_SCHEMA_VERSION => target_snapshot(
                    target_id,
                    target,
                    selected_target_id,
                    gpu_required,
                    Ok(device),
                ),
                Ok(_) => unavailable_target(
                    target_id,
                    Some((target, target_id == selected_target_id)),
                    "Remote resource schema is unsupported",
                ),
                Err(error) => unavailable_target(
                    target_id,
                    Some((target, target_id == selected_target_id)),
                    &format!("Remote resource payload is invalid: {error}"),
                ),
            }
        }
        Ok(response) => unavailable_target(
            target_id,
            Some((target, target_id == selected_target_id)),
            response
                .error
                .as_deref()
                .unwrap_or("Remote resource inspection failed"),
        ),
        Err(error) => unavailable_target(
            target_id,
            Some((target, target_id == selected_target_id)),
            &error.to_string(),
        ),
    }
}

fn target_snapshot(
    target_id: &str,
    target: &ComputeTarget,
    selected_target_id: &str,
    gpu_required: bool,
    device: Result<DeviceResourceSnapshot, String>,
) -> TargetResourceSnapshot {
    match device {
        Ok(device) => {
            let (status, admission_allowed, governance_reasons) =
                evaluate_governance(target, &device, gpu_required);
            TargetResourceSnapshot {
                target_id: target_id.to_string(),
                selected: target_id == selected_target_id,
                host_kind: target.host_kind().to_string(),
                isolation_kind: target.isolation_kind().to_string(),
                environment_identity: environment_identity(target),
                capabilities: target.capabilities.clone(),
                status,
                admission_allowed,
                governance_reasons,
                device: Some(device),
                error: None,
            }
        }
        Err(error) => unavailable_target(
            target_id,
            Some((target, target_id == selected_target_id)),
            &error,
        ),
    }
}

fn evaluate_governance(
    target: &ComputeTarget,
    device: &DeviceResourceSnapshot,
    gpu_required: bool,
) -> (ResourcePressure, bool, Vec<String>) {
    let mut status = ResourcePressure::Healthy;
    let mut admission_allowed = true;
    let mut reasons = Vec::new();
    for metric in &device.metrics {
        status = status.max(metric.pressure);
        if metric.pressure == ResourcePressure::Critical {
            reasons.push(format!("{} is under critical pressure", metric.label));
            if matches!(metric.kind.as_str(), "memory" | "disk")
                || (metric.kind == "gpu" && gpu_required)
            {
                admission_allowed = false;
            }
        } else if metric.pressure == ResourcePressure::Warning {
            reasons.push(format!(
                "{} is approaching its governance threshold",
                metric.label
            ));
        } else if metric.pressure == ResourcePressure::Unavailable {
            reasons.push(format!("{} telemetry is unavailable", metric.label));
            if matches!(metric.kind.as_str(), "memory" | "disk") {
                admission_allowed = false;
            }
        }
    }
    if target.capabilities.iter().any(|value| value == "gpu")
        && !device.metrics.iter().any(|metric| metric.kind == "gpu")
    {
        status = status.max(ResourcePressure::Warning);
        if gpu_required {
            admission_allowed = false;
            reasons.push("GPU capability is required but GPU telemetry is unavailable".to_string());
        } else {
            reasons.push("GPU-capable target has no compatible GPU telemetry".to_string());
        }
    }
    if reasons.is_empty() {
        reasons.push("All observed governed resources are within threshold".to_string());
    }
    (status, admission_allowed, reasons)
}

fn unavailable_target(
    target_id: &str,
    target: Option<(&ComputeTarget, bool)>,
    error: &str,
) -> TargetResourceSnapshot {
    TargetResourceSnapshot {
        target_id: target_id.to_string(),
        selected: target.is_some_and(|(_, selected)| selected),
        host_kind: target
            .map_or("unknown", |(target, _)| target.host_kind())
            .to_string(),
        isolation_kind: target
            .map_or("unknown", |(target, _)| target.isolation_kind())
            .to_string(),
        environment_identity: target.map_or_else(
            || "unknown".to_string(),
            |(target, _)| environment_identity(target),
        ),
        capabilities: target.map_or_else(Vec::new, |(target, _)| target.capabilities.clone()),
        status: ResourcePressure::Unavailable,
        admission_allowed: false,
        governance_reasons: vec!["Resource governance telemetry is unavailable".to_string()],
        device: None,
        error: Some(error.chars().take(512).collect()),
    }
}

fn target_requires_gpu(config: Option<&crate::ToolchainConfigDocument>, target_id: &str) -> bool {
    config.is_some_and(|config| {
        config.config.compute.default_target == target_id
            && config
                .config
                .compute
                .required_capabilities
                .iter()
                .any(|capability| capability == "gpu")
    })
}

fn environment_identity(target: &ComputeTarget) -> String {
    match &target.isolation {
        ComputeIsolation::Native => "native".to_string(),
        ComputeIsolation::Docker { engine, image, .. } => format!("{engine}:{image}"),
        ComputeIsolation::Conda {
            environment,
            explicit_spec_sha256,
        } => format!("conda:{environment}@{}", &explicit_spec_sha256[..12]),
    }
}

fn capacity_metric(
    device_id: &str,
    kind: &str,
    label: &str,
    capacity: u64,
    available: u64,
    warning_available_bps: u16,
    critical_available_bps: u16,
) -> ResourceMetricSnapshot {
    let available_bps = ratio_basis_points(available, capacity);
    let utilization = 10_000_u16.saturating_sub(available_bps);
    let pressure = if capacity == 0 {
        ResourcePressure::Unavailable
    } else if available_bps <= critical_available_bps {
        ResourcePressure::Critical
    } else if available_bps <= warning_available_bps {
        ResourcePressure::Warning
    } else {
        ResourcePressure::Healthy
    };
    ResourceMetricSnapshot {
        resource_id: format!("{device_id}:{kind}"),
        kind: kind.to_string(),
        label: label.to_string(),
        unit: "bytes".to_string(),
        capacity: Some(capacity),
        available: Some(available),
        utilization_basis_points: Some(utilization),
        pressure,
        detail: format!("{available} of {capacity} bytes available"),
    }
}

fn unavailable_metric(
    device_id: &str,
    kind: &str,
    label: &str,
    detail: &str,
) -> ResourceMetricSnapshot {
    ResourceMetricSnapshot {
        resource_id: format!("{device_id}:{kind}"),
        kind: kind.to_string(),
        label: label.to_string(),
        unit: "unknown".to_string(),
        capacity: None,
        available: None,
        utilization_basis_points: None,
        pressure: ResourcePressure::Unavailable,
        detail: detail.to_string(),
    }
}

fn inspect_nvidia_gpus(device_id: &str) -> Vec<ResourceMetricSnapshot> {
    let Some(output) = bounded_command_output(
        "nvidia-smi",
        &[
            "--query-gpu=uuid,name,memory.total,memory.free,utilization.gpu",
            "--format=csv,noheader,nounits",
        ],
    ) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output)
        .lines()
        .take(MAX_GPU_DEVICES)
        .enumerate()
        .filter_map(|(index, line)| {
            let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
            if fields.len() != 5 {
                return None;
            }
            let total_mib = fields[2].parse::<u64>().ok()?;
            let free_mib = fields[3].parse::<u64>().ok()?.min(total_mib);
            let utilization = fields[4].parse::<f32>().ok()?;
            let memory_used_bps =
                10_000_u16.saturating_sub(ratio_basis_points(free_mib, total_mib));
            let utilization_bps = percent_basis_points(utilization).max(memory_used_bps);
            Some(ResourceMetricSnapshot {
                resource_id: format!("{device_id}:gpu:{}", stable_short_id(fields[0])),
                kind: "gpu".to_string(),
                label: bounded_label(fields[1], 128),
                unit: "bytes".to_string(),
                capacity: Some(total_mib.saturating_mul(1024 * 1024)),
                available: Some(free_mib.saturating_mul(1024 * 1024)),
                utilization_basis_points: Some(utilization_bps),
                pressure: high_usage_pressure(utilization_bps, GPU_WARNING_BPS, GPU_CRITICAL_BPS),
                detail: format!("GPU {} · {} MiB free", index + 1, free_mib),
            })
        })
        .collect()
}

fn bounded_command_output(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_COMMAND_OUTPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()
            .map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().ok()? {
            break status;
        }
        if started.elapsed() >= COMMAND_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let bytes = reader.join().ok()??;
    (status.success() && bytes.len() <= MAX_COMMAND_OUTPUT_BYTES as usize).then_some(bytes)
}

fn stable_device_id(host_name: &str) -> String {
    format!(
        "device-{}",
        stable_short_id(&format!("{}:{host_name}", std::env::consts::OS))
    )
}

fn stable_short_id(value: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    digest[..16].to_string()
}

fn bounded_label(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|value| !value.is_control())
        .take(max_chars)
        .collect()
}

fn percent_basis_points(value: f32) -> u16 {
    (value.clamp(0.0, 100.0) * 100.0).round() as u16
}

fn ratio_basis_points(numerator: u64, denominator: u64) -> u16 {
    if denominator == 0 {
        return 0;
    }
    ((u128::from(numerator.min(denominator)) * 10_000) / u128::from(denominator)) as u16
}

fn high_usage_pressure(value: u16, warning: u16, critical: u16) -> ResourcePressure {
    if value >= critical {
        ResourcePressure::Critical
    } else if value >= warning {
        ResourcePressure::Warning
    } else {
        ResourcePressure::Healthy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_capacity_pressure_blocks_governed_admission() {
        let target = ComputeTarget::local_native();
        let device = DeviceResourceSnapshot {
            schema_version: 1,
            device_id: "device-test".to_string(),
            host_name: "test".to_string(),
            operating_system: "test".to_string(),
            architecture: "test".to_string(),
            observed_at: "2026-09-01T00:00:00Z".to_string(),
            cpu_logical_count: 8,
            metrics: vec![capacity_metric(
                "device-test",
                "memory",
                "Memory",
                100,
                5,
                MEMORY_AVAILABLE_WARNING_BPS,
                MEMORY_AVAILABLE_CRITICAL_BPS,
            )],
        };
        let (status, allowed, reasons) = evaluate_governance(&target, &device, false);
        assert_eq!(status, ResourcePressure::Critical);
        assert!(!allowed);
        assert!(reasons.iter().any(|reason| reason.contains("Memory")));
    }

    #[test]
    fn required_gpu_without_telemetry_is_an_admission_gap() {
        let mut target = ComputeTarget::local_native();
        target.capabilities.push("gpu".to_string());
        let device = DeviceResourceSnapshot {
            schema_version: 1,
            device_id: "device-test".to_string(),
            host_name: "test".to_string(),
            operating_system: "test".to_string(),
            architecture: "test".to_string(),
            observed_at: "2026-09-01T00:00:00Z".to_string(),
            cpu_logical_count: 8,
            metrics: Vec::new(),
        };
        let (status, allowed, reasons) = evaluate_governance(&target, &device, true);
        assert_eq!(status, ResourcePressure::Warning);
        assert!(!allowed);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("GPU telemetry"))
        );
    }

    #[test]
    fn optional_gpu_telemetry_gap_warns_without_blocking_cpu_work() {
        let mut target = ComputeTarget::local_native();
        target.capabilities.push("gpu".to_string());
        let device = DeviceResourceSnapshot {
            schema_version: 1,
            device_id: "device-test".to_string(),
            host_name: "test".to_string(),
            operating_system: "test".to_string(),
            architecture: "test".to_string(),
            observed_at: "2026-09-01T00:00:00Z".to_string(),
            cpu_logical_count: 8,
            metrics: Vec::new(),
        };
        let (status, allowed, reasons) = evaluate_governance(&target, &device, false);
        assert_eq!(status, ResourcePressure::Warning);
        assert!(allowed);
        assert!(reasons.iter().any(|reason| reason.contains("GPU-capable")));
    }

    #[test]
    fn local_inspection_reports_bounded_core_resources() {
        let root = tempfile::tempdir().unwrap();
        let snapshot = inspect_local_resources(root.path()).unwrap();
        assert_eq!(snapshot.schema_version, 1);
        assert!(!snapshot.device_id.is_empty());
        assert!(snapshot.cpu_logical_count > 0);
        for kind in ["cpu", "memory", "disk"] {
            assert!(snapshot.metrics.iter().any(|metric| metric.kind == kind));
        }
        assert!(snapshot.metrics.len() <= 3 + MAX_GPU_DEVICES);
    }

    #[test]
    fn ratios_are_bounded_and_deterministic() {
        assert_eq!(ratio_basis_points(5, 10), 5_000);
        assert_eq!(ratio_basis_points(11, 10), 10_000);
        assert_eq!(ratio_basis_points(1, 0), 0);
    }
}
