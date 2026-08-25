//! Serialized Workspace authority and its non-blocking committed identity view.

use std::sync::Arc;

use arc_swap::ArcSwap;
use rho_core::BrokerState;
use rho_protocol::WorkspaceIdentity;
use rho_store::StoreExecutor;
use tokio::sync::{Mutex, MutexGuard};

pub struct WorkspaceBrokerState {
    pub broker: BrokerState,
    pub executor: StoreExecutor,
}

/// Exclusive mutation lane for Workspace R and its Broker identity.
pub struct WorkspaceBrokerLane {
    state: Mutex<WorkspaceBrokerState>,
    identity: ArcSwap<WorkspaceIdentity>,
}

impl WorkspaceBrokerLane {
    pub fn new(broker: BrokerState, executor: StoreExecutor) -> Self {
        let identity = Arc::new(broker.identity().clone());
        Self {
            state: Mutex::new(WorkspaceBrokerState { broker, executor }),
            identity: ArcSwap::from(identity),
        }
    }

    /// Acquire the serialized Workspace authority lane. The committed
    /// identity projection is republished when the guard is released.
    pub async fn lock(&self) -> WorkspaceBrokerGuard<'_> {
        WorkspaceBrokerGuard {
            state: self.state.lock().await,
            identity: &self.identity,
        }
    }

    /// Read the last fully released Workspace identity without waiting for a
    /// currently executing Workspace operation.
    pub fn identity(&self) -> Arc<WorkspaceIdentity> {
        self.identity.load_full()
    }
}

pub struct WorkspaceBrokerGuard<'a> {
    state: MutexGuard<'a, WorkspaceBrokerState>,
    identity: &'a ArcSwap<WorkspaceIdentity>,
}

impl std::ops::Deref for WorkspaceBrokerGuard<'_> {
    type Target = WorkspaceBrokerState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

impl std::ops::DerefMut for WorkspaceBrokerGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.state
    }
}

impl Drop for WorkspaceBrokerGuard<'_> {
    fn drop(&mut self) {
        self.identity
            .store(Arc::new(self.state.broker.identity().clone()));
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;

    async fn test_lane(directory: &TempDir, workspace_id: &str) -> WorkspaceBrokerLane {
        let store_path = directory.path().join(format!("{workspace_id}.sqlite"));
        WorkspaceBrokerLane::new(
            BrokerState::new(workspace_id),
            StoreExecutor::open(&store_path).await.unwrap(),
        )
    }

    #[tokio::test]
    async fn workspace_broker_lane_identity_reads_do_not_wait_or_publish_partial_state() {
        let directory = TempDir::new().unwrap();
        let lane = test_lane(&directory, "ws-lane").await;
        let initial = lane.identity();
        let mut workspace = lane.lock().await;
        workspace.broker.project_changed();

        let while_held = lane.identity();
        assert_eq!(
            while_held.project_revision, initial.project_revision,
            "identity projection exposed an uncommitted lane mutation"
        );
        drop(workspace);

        let committed = lane.identity();
        assert_eq!(committed.project_revision, initial.project_revision + 1);
    }

    #[tokio::test]
    async fn workspace_broker_lane_serializes_and_recovers_after_cancelled_waiter() {
        let directory = TempDir::new().unwrap();
        let lane = Arc::new(test_lane(&directory, "ws-serial").await);
        let first = lane.lock().await;
        let waiting_lane = Arc::clone(&lane);
        let waiter = tokio::spawn(async move {
            let _workspace = waiting_lane.lock().await;
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        drop(first);

        let mut recovered = tokio::time::timeout(Duration::from_millis(100), lane.lock())
            .await
            .expect("cancelled waiter poisoned the Workspace lane");
        recovered.broker.project_changed();
        drop(recovered);
        assert_eq!(lane.identity().project_revision, 1);
    }

    #[tokio::test]
    async fn workspace_broker_lane_keeps_two_workspace_identities_isolated() {
        let directory = TempDir::new().unwrap();
        let lane_a = test_lane(&directory, "ws-a").await;
        let lane_b = test_lane(&directory, "ws-b").await;
        {
            let mut workspace_a = lane_a.lock().await;
            workspace_a.broker.project_changed();
        }

        assert_eq!(lane_a.identity().workspace_id, "ws-a");
        assert_eq!(lane_a.identity().project_revision, 1);
        assert_eq!(lane_b.identity().workspace_id, "ws-b");
        assert_eq!(lane_b.identity().project_revision, 0);
    }
}
