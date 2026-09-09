use async_trait::async_trait;
use rho_environment::EnvironmentUsage;
use rho_workspace::{SnapshotArguments, WorkspaceQuery, WorkspaceRuntime, WorkspaceSnapshotData};
use std::sync::Arc;

pub(crate) struct WorkspaceUsage(pub Arc<dyn WorkspaceRuntime>);
pub(crate) struct InstancesUsage(pub Arc<crate::instances::InstanceOwner>);
#[async_trait]
impl EnvironmentUsage for InstancesUsage {
    async fn protected_paths(&self) -> Result<Vec<String>, String> { self.0.protected_libraries().await }
}
#[async_trait]
impl EnvironmentUsage for WorkspaceUsage {
    async fn protected_paths(&self) -> Result<Vec<String>, String> {
        let observed = self
            .0
            .query(&WorkspaceQuery::Snapshot(SnapshotArguments {
                limit: 1,
                expected_session: Some(self.0.session_id().into()),
            }))
            .await
            .map_err(|error| error.message)?;
        if observed.session_id != self.0.session_id() {
            return Err("Workspace session changed during library-use observation".into());
        }
        let snapshot: WorkspaceSnapshotData =
            serde_json::from_value(observed.data).map_err(|error| error.to_string())?;
        if !snapshot.library_usage_complete {
            return Err("Workspace library-use observation is incomplete".into());
        }
        Ok(snapshot
            .library_paths
            .into_iter()
            .chain(snapshot.namespace_paths)
            .collect())
    }
}
