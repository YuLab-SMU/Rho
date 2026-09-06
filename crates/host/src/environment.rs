use rho_contract::{OperationId, OperationStatus};
use rho_environment::{EnvironmentRealization, EnvironmentRuntime, REALIZE_CAPABILITY};
use rho_operation::{OperationError, OperationJournal};
pub use rho_r_environment::REnvironmentConfig;

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
