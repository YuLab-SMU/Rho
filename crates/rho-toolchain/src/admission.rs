use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    DoctorReport, DoctorStatus, TargetRegistryDocument, ToolchainConfigDocument, ToolchainError,
    doctor_for_target, load_toolchain_config, monitor_target_resource,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetAdmissionMode {
    Workspace,
    Run,
    Live,
    Sync,
    Lock,
    PackageInstall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetAdmission {
    mode: TargetAdmissionMode,
    project_root: PathBuf,
    rho_toml_sha256: String,
    target_id: String,
    target_registry_sha256: Option<String>,
    host_kind: String,
    isolation_kind: String,
    admitted_at: String,
    doctor: DoctorReport,
}

impl TargetAdmission {
    pub fn mode(&self) -> TargetAdmissionMode {
        self.mode
    }

    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    pub fn rho_toml_sha256(&self) -> &str {
        &self.rho_toml_sha256
    }

    pub fn target_id(&self) -> &str {
        &self.target_id
    }

    pub fn target_registry_sha256(&self) -> Option<&str> {
        self.target_registry_sha256.as_deref()
    }

    pub fn host_kind(&self) -> &str {
        &self.host_kind
    }

    pub fn isolation_kind(&self) -> &str {
        &self.isolation_kind
    }

    pub fn admitted_at(&self) -> &str {
        &self.admitted_at
    }

    pub fn doctor_report(&self) -> &DoctorReport {
        &self.doctor
    }

    pub fn validate(
        &self,
        config: &ToolchainConfigDocument,
        targets: &TargetRegistryDocument,
        mode: TargetAdmissionMode,
    ) -> Result<(), ToolchainError> {
        let target = targets
            .registry
            .resolve(&config.config.compute.default_target)?;
        if self.mode != mode
            || self.project_root != config.project_root
            || self.rho_toml_sha256 != config.sha256
            || self.target_id != config.config.compute.default_target
            || self.target_registry_sha256 != targets.sha256
            || self.host_kind != target.host_kind()
            || self.isolation_kind != target.isolation_kind()
            || self.doctor.status != DoctorStatus::Ready
            || self.doctor.project_root != config.project_root
            || self.doctor.rho_toml_sha256 != config.sha256
            || self.doctor.target_id != self.target_id
            || self.doctor.target_registry_sha256 != targets.sha256
            || self.doctor.host_kind != self.host_kind
            || self.doctor.isolation_kind != self.isolation_kind
            || self.doctor.schema_version != 1
            || self
                .doctor
                .checks
                .iter()
                .any(|check| check.status != DoctorStatus::Ready)
        {
            return Err(ToolchainError::InvalidTarget(
                "Target Admission is stale or belongs to another realization".to_string(),
            ));
        }
        if let Some(capability) = config
            .config
            .compute
            .required_capabilities
            .iter()
            .find(|capability| !target.capabilities.contains(capability))
        {
            return Err(ToolchainError::InvalidTarget(format!(
                "target lacks required capability {capability}"
            )));
        }
        validate_runtime_evidence(config, &self.doctor)?;
        validate_mode(config, mode)?;
        Ok(())
    }

    pub fn for_mode(
        &self,
        config: &ToolchainConfigDocument,
        targets: &TargetRegistryDocument,
        mode: TargetAdmissionMode,
    ) -> Result<Self, ToolchainError> {
        let mut admission = self.clone();
        admission.mode = mode;
        admission.validate(config, targets, mode)?;
        Ok(admission)
    }

    pub(crate) fn from_verified_report(
        config: &ToolchainConfigDocument,
        targets: &TargetRegistryDocument,
        mode: TargetAdmissionMode,
        doctor: DoctorReport,
    ) -> Result<Self, ToolchainError> {
        let target = targets
            .registry
            .resolve(&config.config.compute.default_target)?;
        let admission = Self {
            mode,
            project_root: config.project_root.clone(),
            rho_toml_sha256: config.sha256.clone(),
            target_id: config.config.compute.default_target.clone(),
            target_registry_sha256: targets.sha256.clone(),
            host_kind: target.host_kind().to_string(),
            isolation_kind: target.isolation_kind().to_string(),
            admitted_at: Utc::now().to_rfc3339(),
            doctor,
        };
        admission.validate(config, targets, mode)?;
        Ok(admission)
    }
}

pub fn admit_target(
    project_root: &Path,
    targets: &TargetRegistryDocument,
    mode: TargetAdmissionMode,
) -> Result<TargetAdmission, ToolchainError> {
    let config = load_toolchain_config(project_root)?;
    let doctor = doctor_for_target(&config.project_root, targets)?;
    let admission = TargetAdmission::from_verified_report(&config, targets, mode, doctor)?;
    let resources = monitor_target_resource(&config.project_root, targets, admission.target_id())?;
    if !resources.admission_allowed {
        return Err(ToolchainError::InvalidTarget(format!(
            "resource governance blocked target {}: {}",
            admission.target_id(),
            resources.governance_reasons.join("; ")
        )));
    }
    Ok(admission)
}

fn validate_runtime_evidence(
    config: &ToolchainConfigDocument,
    doctor: &DoctorReport,
) -> Result<(), ToolchainError> {
    match (&config.config.runtime.r, &doctor.r_version, &doctor.rscript) {
        (Some(expected), Some(version), Some(_)) if version == &expected.version.to_string() => {}
        (None, None, None) => {}
        _ => {
            return Err(ToolchainError::InvalidTarget(
                "Target Admission does not contain the configured R realization".to_string(),
            ));
        }
    }
    match (
        &config.config.runtime.python,
        &doctor.python_version,
        &doctor.python,
    ) {
        (Some(expected), Some(version), Some(_)) if version == &expected.version.to_string() => {}
        (None, None, None) => {}
        _ => {
            return Err(ToolchainError::InvalidTarget(
                "Target Admission does not contain the configured Python realization".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_mode(
    config: &ToolchainConfigDocument,
    mode: TargetAdmissionMode,
) -> Result<(), ToolchainError> {
    if mode == TargetAdmissionMode::Workspace && config.config.runtime.r.is_none() {
        return Err(ToolchainError::InvalidTarget(
            "Workspace Target Admission requires a configured R runtime".to_string(),
        ));
    }
    if mode == TargetAdmissionMode::PackageInstall && config.config.runtime.r.is_none() {
        return Err(ToolchainError::InvalidTarget(
            "R package Target Admission requires a configured R runtime".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::{DoctorCheck, load_target_registry};

    fn ready_report(
        config: &ToolchainConfigDocument,
        targets: &TargetRegistryDocument,
    ) -> DoctorReport {
        DoctorReport {
            schema_version: 1,
            status: DoctorStatus::Ready,
            project_root: config.project_root.clone(),
            rho_toml_sha256: config.sha256.clone(),
            target_id: config.config.compute.default_target.clone(),
            target_registry_sha256: targets.sha256.clone(),
            host_kind: "local".to_string(),
            isolation_kind: "native".to_string(),
            r_version: Some("4.5.2".to_string()),
            rscript: Some(PathBuf::from("/R/4.5.2/Rscript")),
            python_version: None,
            python: None,
            checks: vec![DoctorCheck {
                id: "fixture".to_string(),
                status: DoctorStatus::Ready,
                detail: "ready".to_string(),
            }],
        }
    }

    #[test]
    fn admission_binds_mode_config_target_and_ready_doctor_evidence() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("rho.toml"),
            "schema = 1\n[runtime.r]\nversion = \"4.5.2\"\nmanager = \"rig\"\nenvironment = \"renv\"\nlockfile = \"renv.lock\"\ninstaller = \"pak\"\n",
        )
        .unwrap();
        let config = load_toolchain_config(root.path()).unwrap();
        let targets = load_target_registry(root.path()).unwrap();
        let admission = TargetAdmission::from_verified_report(
            &config,
            &targets,
            TargetAdmissionMode::Workspace,
            ready_report(&config, &targets),
        )
        .unwrap();
        assert_eq!(admission.target_id(), "local");
        assert_eq!(admission.mode(), TargetAdmissionMode::Workspace);
        assert!(
            admission
                .validate(&config, &targets, TargetAdmissionMode::Run)
                .is_err()
        );
        let run_admission = admission
            .for_mode(&config, &targets, TargetAdmissionMode::Run)
            .unwrap();

        fs::write(
            root.path().join("rho.toml"),
            "schema = 1\n[runtime.r]\nversion = \"4.5.3\"\nmanager = \"rig\"\nenvironment = \"renv\"\nlockfile = \"renv.lock\"\ninstaller = \"pak\"\n",
        )
        .unwrap();
        let changed = load_toolchain_config(root.path()).unwrap();
        assert!(
            run_admission
                .validate(&changed, &targets, TargetAdmissionMode::Run)
                .is_err()
        );
    }

    #[test]
    fn failed_doctor_evidence_never_becomes_admission() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("rho.toml"),
            "schema = 1\n[runtime.r]\nversion = \"4.5.2\"\nmanager = \"rig\"\nenvironment = \"renv\"\nlockfile = \"renv.lock\"\ninstaller = \"pak\"\n",
        )
        .unwrap();
        let config = load_toolchain_config(root.path()).unwrap();
        let targets = load_target_registry(root.path()).unwrap();
        let mut report = ready_report(&config, &targets);
        report.status = DoctorStatus::Failed;
        assert!(
            TargetAdmission::from_verified_report(
                &config,
                &targets,
                TargetAdmissionMode::Workspace,
                report,
            )
            .is_err()
        );
    }
}
