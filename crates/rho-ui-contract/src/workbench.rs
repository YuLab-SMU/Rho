use serde::{Deserialize, Serialize};

use crate::{
    ContractError, ProjectId, ProjectUiProfileSnapshotV1, ResourceRegistrySnapshotV1,
    RuntimeRegistrySnapshotV1, StudioRuntimeSnapshotV1, SurfaceRuntimeSnapshotV1,
    UiKernelSnapshotV1, Validate, encoded_json_len,
};

pub const WORKBENCH_PROJECTION_CONTRACT: &str = "rho.ui.workbench-projection.v1";
pub const MAX_WORKBENCH_PROJECTION_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct WorkbenchRevisionVectorV1 {
    #[specta(type = crate::UiIpcNumber)]
    pub project_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub kernel_snapshot_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub surface_snapshot_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub studio_snapshot_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub layout_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub runtime_snapshot_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub resource_snapshot_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub profile_revision: u64,
}

impl WorkbenchRevisionVectorV1 {
    pub fn from_snapshots(
        kernel: &UiKernelSnapshotV1,
        surfaces: &SurfaceRuntimeSnapshotV1,
        studio: &StudioRuntimeSnapshotV1,
        runtimes: &RuntimeRegistrySnapshotV1,
        resources: &ResourceRegistrySnapshotV1,
        profile: &ProjectUiProfileSnapshotV1,
    ) -> Self {
        Self {
            project_revision: kernel.context.project_revision,
            kernel_snapshot_revision: kernel.snapshot_revision,
            surface_snapshot_revision: surfaces.snapshot_revision,
            studio_snapshot_revision: studio.snapshot_revision,
            layout_revision: studio.scene.layout_revision,
            runtime_snapshot_revision: runtimes.snapshot_revision,
            resource_snapshot_revision: resources.snapshot_revision,
            profile_revision: profile.profile.revision,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct WorkbenchProjectionV1 {
    pub contract: String,
    #[specta(type = crate::UiIpcNumber)]
    pub contract_major: u16,
    #[specta(type = crate::UiIpcNumber)]
    pub projection_generation: u64,
    pub project_id: ProjectId,
    pub revisions: WorkbenchRevisionVectorV1,
    pub kernel: UiKernelSnapshotV1,
    pub surfaces: SurfaceRuntimeSnapshotV1,
    pub studio: StudioRuntimeSnapshotV1,
    pub runtimes: RuntimeRegistrySnapshotV1,
    pub resources: ResourceRegistrySnapshotV1,
    pub profile: ProjectUiProfileSnapshotV1,
}

impl Validate for WorkbenchProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != WORKBENCH_PROJECTION_CONTRACT
            || self.contract_major != crate::RSR_CONTRACT_MAJOR
        {
            return Err(ContractError::InvalidValue {
                path: "workbench_projection.contract".to_string(),
                reason: "unsupported Workbench projection contract".to_string(),
            });
        }
        if self.projection_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "workbench_projection.projection_generation".to_string(),
                reason: "projection generation must be positive".to_string(),
            });
        }

        self.kernel.validate()?;
        self.surfaces.validate()?;
        self.studio.validate()?;
        self.runtimes.validate()?;
        self.resources.validate()?;
        self.profile.validate()?;

        let project_ids = [
            &self.kernel.project.project_id,
            &self.kernel.context.project_id,
            &self.surfaces.project_id,
            &self.studio.project_id,
            &self.studio.scene.project_id,
            &self.runtimes.project_id,
            &self.resources.project_id,
            &self.profile.profile.project_id,
        ];
        if project_ids
            .into_iter()
            .any(|project_id| project_id != &self.project_id)
        {
            return Err(ContractError::InvalidValue {
                path: "workbench_projection.project_id".to_string(),
                reason: "nested snapshot belongs to another project".to_string(),
            });
        }

        let project_revisions = [
            self.kernel.context.project_revision,
            self.surfaces.project_revision,
            self.studio.project_revision,
            self.runtimes.project_revision,
            self.resources.project_revision,
        ];
        if self.revisions.project_revision == 0
            || project_revisions
                .into_iter()
                .any(|revision| revision != self.revisions.project_revision)
        {
            return Err(ContractError::InvalidValue {
                path: "workbench_projection.revisions.project_revision".to_string(),
                reason: "nested snapshot project revisions are not coherent".to_string(),
            });
        }

        let expected = WorkbenchRevisionVectorV1::from_snapshots(
            &self.kernel,
            &self.surfaces,
            &self.studio,
            &self.runtimes,
            &self.resources,
            &self.profile,
        );
        if self.revisions != expected {
            return Err(ContractError::InvalidValue {
                path: "workbench_projection.revisions".to_string(),
                reason: "revision vector differs from nested snapshots".to_string(),
            });
        }

        let encoded = encoded_json_len("workbench_projection", self)?;
        if encoded > MAX_WORKBENCH_PROJECTION_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "workbench_projection".to_string(),
                limit: MAX_WORKBENCH_PROJECTION_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projection() -> WorkbenchProjectionV1 {
        let fixture = crate::golden_contract_fixture();
        let revisions = WorkbenchRevisionVectorV1::from_snapshots(
            &fixture.kernel_snapshot,
            &fixture.surface_runtime_snapshot,
            &fixture.studio_runtime_snapshot,
            &fixture.runtime_registry_snapshot,
            &fixture.resource_registry_snapshot,
            &fixture.project_ui_profile_snapshot,
        );
        WorkbenchProjectionV1 {
            contract: WORKBENCH_PROJECTION_CONTRACT.to_string(),
            contract_major: crate::RSR_CONTRACT_MAJOR,
            projection_generation: 1,
            project_id: fixture.kernel_snapshot.project.project_id.clone(),
            revisions,
            kernel: fixture.kernel_snapshot,
            surfaces: fixture.surface_runtime_snapshot,
            studio: fixture.studio_runtime_snapshot,
            runtimes: fixture.runtime_registry_snapshot,
            resources: fixture.resource_registry_snapshot,
            profile: fixture.project_ui_profile_snapshot,
        }
    }

    #[test]
    fn workbench_projection_validates_one_project_and_revision_vector() {
        let projection = projection();
        projection.validate().unwrap();

        let mut project_drift = projection.clone();
        project_drift.resources.project_id = ProjectId::new("project:other").unwrap();
        assert!(project_drift.validate().is_err());

        let mut revision_drift = projection;
        revision_drift.revisions.layout_revision += 1;
        assert!(matches!(
            revision_drift.validate(),
            Err(ContractError::InvalidValue { path, .. })
                if path == "workbench_projection.revisions"
        ));
    }
}
