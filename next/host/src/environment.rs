use async_trait::async_trait;
use rho_next_contract::{OperationId, OperationRecord, OperationStatus};
use rho_next_environment::{
    EnvironmentRealization, EnvironmentRecords, EnvironmentRuntime, REALIZE_CAPABILITY,
};
use rho_next_operation::{OperationError, OperationJournal};
pub use rho_next_r_environment::REnvironmentConfig;
use std::sync::Arc;

pub(crate) struct EnvironmentJournal(pub Arc<dyn OperationJournal>);
#[async_trait]
impl EnvironmentRecords for EnvironmentJournal {
    async fn get(&self, id: &str) -> Result<Option<OperationRecord>, String> {
        let id = OperationId::new(id).map_err(|e| e.to_string())?;
        self.0.get(&id).await.map_err(|e| e.to_string())
    }
}

pub(crate) async fn selected_environment(
    journal: &dyn OperationJournal,
    runtime: &dyn EnvironmentRuntime,
    id: &str,
) -> Result<EnvironmentRealization, OperationError> {
    let record = journal
        .get(&OperationId::new(id)?)
        .await?
        .ok_or_else(|| OperationError::NotFound(id.into()))?;
    if record.status != OperationStatus::Succeeded
        || record.operation.capability.id != REALIZE_CAPABILITY
        || record.operation.idempotency_scope.as_deref() != Some(runtime.root())
    {
        return Err(OperationError::InvalidInput(
            "environment selection requires a successful realization in this project".into(),
        ));
    }
    let receipt: EnvironmentRealization = serde_json::from_value(
        record
            .output
            .ok_or_else(|| OperationError::InvalidInput("realization has no output".into()))?,
    )
    .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
    let verification = runtime
        .verify(id, &receipt, tokio::sync::watch::channel(false).1)
        .await
        .map_err(|e| OperationError::TargetResolution(e.message))?;
    if !receipt.verified || !verification.verified {
        return Err(OperationError::TargetResolution(format!(
            "selected environment no longer verifies: {:?}",
            verification.errors
        )));
    }
    Ok(receipt)
}
