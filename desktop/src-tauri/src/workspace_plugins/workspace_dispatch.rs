use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Result;
use rho_core::ExecutionOrigin;
use rho_kernel::ArkSession;
use rho_server::coordinator::dispatch_workspace_request;
use rho_server::plugin_workspace::PreparedWorkspaceInspection;
use rho_server::workspace_lane::{WorkspaceBrokerLane, WorkspaceBrokerState};

pub(crate) struct WorkspaceDispatchResult {
    pub response: serde_json::Value,
    pub current_workspace: rho_protocol::WorkspaceIdentity,
}

pub(crate) trait WorkspacePluginDispatcher: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        prepared: PreparedWorkspaceInspection,
    ) -> Pin<Box<dyn Future<Output = Result<WorkspaceDispatchResult>> + Send + 'a>>;
}

#[allow(dead_code)]
pub(crate) struct CoordinatorWorkspacePluginDispatcher {
    pub session: Arc<ArkSession>,
    pub context: Arc<WorkspaceBrokerLane>,
}

impl WorkspacePluginDispatcher for CoordinatorWorkspacePluginDispatcher {
    fn dispatch<'a>(
        &'a self,
        prepared: PreparedWorkspaceInspection,
    ) -> Pin<Box<dyn Future<Output = Result<WorkspaceDispatchResult>> + Send + 'a>> {
        Box::pin(async move {
            let payload = serde_json::json!({
                "arguments": prepared.arguments,
                "expected_workspace": prepared.expected_workspace,
            });
            let mut context = self.context.lock().await;
            let WorkspaceBrokerState {
                broker, executor, ..
            } = &mut *context;
            let response = dispatch_workspace_request(
                prepared.request_type,
                &payload,
                ExecutionOrigin::System,
                self.session.as_ref(),
                broker,
                executor,
            )
            .await?;
            Ok(WorkspaceDispatchResult {
                response,
                current_workspace: broker.identity().clone(),
            })
        })
    }
}
