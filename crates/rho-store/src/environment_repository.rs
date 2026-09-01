//! Asynchronous durable Environment operation request repository.

use crate::{
    EnvironmentIncidentRecord, EnvironmentOperationJournalRecord, EnvironmentPlanReviewRecord,
    EnvironmentStateCommit, EnvironmentStateProjection, Store, StoreExecutor, StoreExecutorError,
    query::required_project_root,
};
use rho_protocol::EnvironmentIncidentV1;

#[derive(Clone, Debug)]
pub struct EnvironmentRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn environment_repository(&self) -> EnvironmentRepository {
        EnvironmentRepository {
            executor: self.clone(),
        }
    }
}

impl EnvironmentRepository {
    pub async fn record_plan_for_review(
        &self,
        project_root: String,
        plan: rho_protocol::MaterializedPackagePlanV1,
    ) -> Result<EnvironmentPlanReviewRecord, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).record_environment_plan_for_review(&project_root, &plan)
            })
            .await
    }

    pub async fn latest_reviewable_plan(
        &self,
        project_root: String,
    ) -> Result<Option<EnvironmentPlanReviewRecord>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).latest_reviewable_environment_plan(&project_root)
            })
            .await
    }

    pub async fn operation(
        &self,
        project_root: String,
        operation_id: String,
    ) -> Result<Option<EnvironmentOperationJournalRecord>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .get_environment_operation_journal(&project_root, &operation_id)
            })
            .await
    }

    pub async fn latest_operation(
        &self,
        project_root: String,
    ) -> Result<Option<EnvironmentOperationJournalRecord>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).latest_environment_operation_journal(&project_root)
            })
            .await
    }

    pub async fn commit_state(
        &self,
        commit: EnvironmentStateCommit,
    ) -> Result<EnvironmentStateProjection, StoreExecutorError> {
        self.executor
            .call(move |connection| Store::borrowed(connection).commit_environment_state(&commit))
            .await
    }

    pub async fn current_state(
        &self,
        project_root: String,
    ) -> Result<Option<EnvironmentStateProjection>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).current_environment_state(&project_root)
            })
            .await
    }

    pub async fn record_incident(
        &self,
        project_root: String,
        incident: EnvironmentIncidentV1,
    ) -> Result<EnvironmentIncidentRecord, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).record_environment_incident(&project_root, &incident)
            })
            .await
    }

    pub async fn list_incidents(
        &self,
        project_root: String,
        include_resolved: bool,
        limit: usize,
    ) -> Result<Vec<EnvironmentIncidentRecord>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).list_environment_incidents(
                    &project_root,
                    include_resolved,
                    limit,
                )
            })
            .await
    }

    pub async fn resolve_incident(
        &self,
        project_root: String,
        environment_id: String,
        incident_id: String,
        resolved_at: String,
    ) -> Result<usize, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).resolve_environment_incident(
                    &project_root,
                    &environment_id,
                    &incident_id,
                    &resolved_at,
                )
            })
            .await
    }
}
