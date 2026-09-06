use async_trait::async_trait;
use rho_contract::{OperationId, OperationRecord};
use rho_operation::{OperationJournal, OperationOutputPage, OperationRecords};
use std::sync::Arc;

pub(crate) struct JournalRecords(pub Arc<dyn OperationJournal>);
#[async_trait]
impl OperationRecords for JournalRecords {
    async fn get(&self, id: &str) -> Result<Option<OperationRecord>, String> {
        let id = OperationId::new(id).map_err(|e| e.to_string())?;
        self.0.get(&id).await.map_err(|e| e.to_string())
    }
    async fn successful_outputs(
        &self,
        scope: &str,
        capability: &rho_contract::CapabilityRef,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<OperationOutputPage, String> {
        self.0
            .successful_outputs(scope, capability, after_id, limit)
            .await
            .map_err(|error| error.to_string())
    }
}
