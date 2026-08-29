use rho_toolchain::{
    DeviceResourceSnapshot, ResourceGovernanceThresholds, ResourceMetricSnapshot,
    ResourceMonitorSnapshot, TargetResourceSnapshot, load_target_registry,
    monitor_project_resources,
};
use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::application_state::ResourceGovernanceCache;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ResourceMetricView {
    pub(crate) resource_id: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) unit: String,
    pub(crate) capacity: Option<String>,
    pub(crate) available: Option<String>,
    pub(crate) utilization_basis_points: Option<u16>,
    pub(crate) pressure: String,
    pub(crate) detail: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct DeviceResourceView {
    pub(crate) device_id: String,
    pub(crate) host_name: String,
    pub(crate) operating_system: String,
    pub(crate) architecture: String,
    pub(crate) observed_at: String,
    pub(crate) cpu_logical_count: u32,
    pub(crate) metrics: Vec<ResourceMetricView>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct TargetResourceView {
    pub(crate) target_id: String,
    pub(crate) selected: bool,
    pub(crate) host_kind: String,
    pub(crate) isolation_kind: String,
    pub(crate) environment_identity: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) status: String,
    pub(crate) admission_allowed: bool,
    pub(crate) governance_reasons: Vec<String>,
    pub(crate) device: Option<DeviceResourceView>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ResourceGovernanceThresholdsView {
    pub(crate) cpu_warning_basis_points: u16,
    pub(crate) cpu_critical_basis_points: u16,
    pub(crate) memory_available_warning_basis_points: u16,
    pub(crate) memory_available_critical_basis_points: u16,
    pub(crate) disk_available_warning_basis_points: u16,
    pub(crate) disk_available_critical_basis_points: u16,
    pub(crate) gpu_warning_basis_points: u16,
    pub(crate) gpu_critical_basis_points: u16,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ResourceMonitorView {
    pub(crate) status: String,
    pub(crate) selected_target_id: String,
    pub(crate) observed_at: String,
    pub(crate) configured: bool,
    pub(crate) rho_toml_sha256: Option<String>,
    pub(crate) target_registry_sha256: Option<String>,
    pub(crate) thresholds: ResourceGovernanceThresholdsView,
    pub(crate) targets: Vec<TargetResourceView>,
    pub(crate) total_targets: u32,
    pub(crate) truncated: bool,
}

fn pressure(value: rho_toolchain::ResourcePressure) -> String {
    match value {
        rho_toolchain::ResourcePressure::Healthy => "healthy",
        rho_toolchain::ResourcePressure::Warning => "warning",
        rho_toolchain::ResourcePressure::Critical => "critical",
        rho_toolchain::ResourcePressure::Unavailable => "unavailable",
    }
    .to_string()
}

impl From<ResourceMetricSnapshot> for ResourceMetricView {
    fn from(value: ResourceMetricSnapshot) -> Self {
        Self {
            resource_id: value.resource_id,
            kind: value.kind,
            label: value.label,
            unit: value.unit,
            capacity: value.capacity.map(|value| value.to_string()),
            available: value.available.map(|value| value.to_string()),
            utilization_basis_points: value.utilization_basis_points,
            pressure: pressure(value.pressure),
            detail: value.detail,
        }
    }
}

impl From<DeviceResourceSnapshot> for DeviceResourceView {
    fn from(value: DeviceResourceSnapshot) -> Self {
        Self {
            device_id: value.device_id,
            host_name: value.host_name,
            operating_system: value.operating_system,
            architecture: value.architecture,
            observed_at: value.observed_at,
            cpu_logical_count: u32::try_from(value.cpu_logical_count).unwrap_or(u32::MAX),
            metrics: value.metrics.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TargetResourceSnapshot> for TargetResourceView {
    fn from(value: TargetResourceSnapshot) -> Self {
        Self {
            target_id: value.target_id,
            selected: value.selected,
            host_kind: value.host_kind,
            isolation_kind: value.isolation_kind,
            environment_identity: value.environment_identity,
            capabilities: value.capabilities,
            status: pressure(value.status),
            admission_allowed: value.admission_allowed,
            governance_reasons: value.governance_reasons,
            device: value.device.map(Into::into),
            error: value.error,
        }
    }
}

impl From<ResourceGovernanceThresholds> for ResourceGovernanceThresholdsView {
    fn from(value: ResourceGovernanceThresholds) -> Self {
        Self {
            cpu_warning_basis_points: value.cpu_warning_basis_points,
            cpu_critical_basis_points: value.cpu_critical_basis_points,
            memory_available_warning_basis_points: value.memory_available_warning_basis_points,
            memory_available_critical_basis_points: value.memory_available_critical_basis_points,
            disk_available_warning_basis_points: value.disk_available_warning_basis_points,
            disk_available_critical_basis_points: value.disk_available_critical_basis_points,
            gpu_warning_basis_points: value.gpu_warning_basis_points,
            gpu_critical_basis_points: value.gpu_critical_basis_points,
        }
    }
}

impl From<ResourceMonitorSnapshot> for ResourceMonitorView {
    fn from(value: ResourceMonitorSnapshot) -> Self {
        Self {
            status: pressure(value.status),
            selected_target_id: value.selected_target_id,
            observed_at: value.observed_at,
            configured: value.rho_toml_sha256.is_some(),
            rho_toml_sha256: value.rho_toml_sha256,
            target_registry_sha256: value.target_registry_sha256,
            thresholds: value.thresholds.into(),
            targets: value.targets.into_iter().map(Into::into).collect(),
            total_targets: u32::try_from(value.total_targets).unwrap_or(u32::MAX),
            truncated: value.truncated,
        }
    }
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn resource_monitor_snapshot(
    state: State<'_, AppState>,
) -> Result<ResourceMonitorView, String> {
    let project_root = state.project_root.read().await.clone();
    let rho_home = crate::agent_llm::agent_config::rho_home().map_err(crate::display_error)?;
    let expected_root = project_root.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let targets = load_target_registry(&rho_home)?;
        monitor_project_resources(&project_root, &targets)
    })
    .await
    .map_err(|error| format!("Resource monitor task failed: {error}"))?
    .map_err(crate::display_error)?;
    if *state.project_root.read().await != expected_root {
        return Err("Resource monitor result is stale after a project switch".to_string());
    }
    let governance = snapshot
        .rho_toml_sha256
        .as_ref()
        .and_then(|rho_toml_sha256| {
            snapshot
                .targets
                .iter()
                .find(|target| target.target_id == snapshot.selected_target_id)
                .map(|target| ResourceGovernanceCache {
                    project_root: expected_root.clone(),
                    rho_toml_sha256: rho_toml_sha256.clone(),
                    target_registry_sha256: snapshot.target_registry_sha256.clone(),
                    target_id: target.target_id.clone(),
                    observed_at: std::time::Instant::now(),
                    admission_allowed: target.admission_allowed,
                    reasons: target.governance_reasons.clone(),
                })
        });
    *state.resource_governance.write().await = governance;
    Ok(snapshot.into())
}
