use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use rho_extension_runtime::{BrokerError, BrokerFacade, BrokerRequest, BrokerResponse};
use rho_kernel::ArkSession;
use rho_server::coordinator::dispatch_workspace_request_with_execution_id;
use rho_server::workspace_lane::{WorkspaceBrokerLane, WorkspaceBrokerState};
use rho_store::RunRepository;
use serde::Deserialize;
use serde_json::json;

use super::plugins::{
    WorkspaceOperation, runs_broker_operation_id, workspace_probe_broker_operation_id,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunHistoryListRequest {
    limit: Option<usize>,
}

enum RunHistoryRepository {
    Ready(RunRepository),
    #[cfg(test)]
    Unavailable(String),
}

pub(crate) struct RunHistoryBrokerFacade {
    repository: RunHistoryRepository,
    project_root: String,
}

impl RunHistoryBrokerFacade {
    pub(crate) fn new(repository: RunRepository, project_root: String) -> Self {
        Self {
            repository: RunHistoryRepository::Ready(repository),
            project_root,
        }
    }

    #[cfg(test)]
    pub(crate) fn unavailable(project_root: String, reason: impl Into<String>) -> Self {
        Self {
            repository: RunHistoryRepository::Unavailable(reason.into()),
            project_root,
        }
    }
}

impl BrokerFacade for RunHistoryBrokerFacade {
    fn call<'a>(
        &'a self,
        request: BrokerRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BrokerResponse, BrokerError>> + Send + 'a>> {
        Box::pin(async move {
            if request.operation_id != runs_broker_operation_id() {
                return Err(BrokerError::Unavailable {
                    operation_id: request.operation_id,
                });
            }
            let arguments: RunHistoryListRequest =
                serde_json::from_value(request.payload.value().clone()).map_err(|error| {
                    BrokerError::rejected("runs_request_invalid", error.to_string())
                })?;
            #[allow(clippy::infallible_destructuring_match)]
            let repository = match &self.repository {
                RunHistoryRepository::Ready(repository) => repository,
                #[cfg(test)]
                RunHistoryRepository::Unavailable(reason) => {
                    return Err(BrokerError::rejected("runs_store_open", reason));
                }
            };
            let runs = repository
                .list_runs(self.project_root.clone(), arguments.limit)
                .await
                .map_err(|error| BrokerError::rejected("runs_list_failed", error.to_string()))?;
            let value = serde_json::to_value(runs).map_err(|error| {
                BrokerError::rejected("runs_response_encode", error.to_string())
            })?;
            BrokerResponse::new(value, &request).map_err(BrokerError::from)
        })
    }
}

pub(crate) struct WorkspaceSnapshotBrokerFacade {
    pub(crate) session: Arc<ArkSession>,
    pub(crate) context: Arc<WorkspaceBrokerLane>,
}

impl BrokerFacade for WorkspaceSnapshotBrokerFacade {
    fn call<'a>(
        &'a self,
        request: BrokerRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BrokerResponse, BrokerError>> + Send + 'a>> {
        Box::pin(async move {
            if request.operation_id != workspace_probe_broker_operation_id() {
                return Err(BrokerError::Unavailable {
                    operation_id: request.operation_id,
                });
            }
            let operation: WorkspaceOperation =
                serde_json::from_value(request.payload.value().clone()).map_err(|error| {
                    BrokerError::rejected("workspace_probe_request_invalid", error.to_string())
                })?;
            let WorkspaceOperation::Snapshot {
                expected_workspace,
                origin,
                execution_id,
            } = operation;
            let payload = json!({
                "arguments": {},
                "expected_workspace": expected_workspace,
            });
            let mut context = self.context.lock().await;
            let WorkspaceBrokerState { broker, executor } = &mut *context;
            let value = dispatch_workspace_request_with_execution_id(
                "workspace.snapshot",
                &payload,
                origin,
                self.session.as_ref(),
                broker,
                executor,
                execution_id.as_deref(),
            )
            .await
            .map_err(|error| {
                BrokerError::rejected("workspace_snapshot_dispatch_failed", error.to_string())
            })?;
            BrokerResponse::new(value, &request).map_err(BrokerError::from)
        })
    }
}
