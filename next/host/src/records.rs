use async_trait::async_trait;
use rho_next_contract::{OperationId, OperationRecord};
use rho_next_operation::{OperationJournal, OperationRecords};
use std::sync::Arc;

pub(crate) struct JournalRecords(pub Arc<dyn OperationJournal>);
#[async_trait]
impl OperationRecords for JournalRecords {
    async fn get(&self, id: &str) -> Result<Option<OperationRecord>, String> {
        let id = OperationId::new(id).map_err(|e| e.to_string())?;
        self.0.get(&id).await.map_err(|e| e.to_string())
    }
}
