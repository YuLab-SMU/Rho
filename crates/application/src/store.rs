use crate::ApplicationError;
use rho_contract::*;
use serde::{Deserialize, Serialize};

/// Set by Host, never accepted from bridge payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationScope {
    pub project: String,
    pub principal: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct StoredSync {
    pub digest: String,
    pub receipt: ApplicationSyncReceipt,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct StoredWindow {
    pub window: ApplicationWindowRef,
    pub revision: String,
    pub host_incarnation: String,
    pub bridge_token: String,
    pub connection_id: String,
    pub renewed_at_ms: u64,
    pub synced_at_ms: Option<u64>,
    pub context: ApplicationContextState,
    pub last_sync: Option<StoredSync>,
}

/// Private application material, never scientific history until explicit execution.
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredCapture {
    pub summary: ApplicationCaptureSummary,
    pub text: String,
    pub base_text: Option<String>,
    pub run_code: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct StoredCommand {
    #[serde(default)]
    pub cancel_requested: bool,
    pub request: ApplicationCommandRequest,
    pub context: CallContext,
    pub receipt: ApplicationCommandReceipt,
    pub claim_id: Option<String>,
    pub claim_request_id: Option<String>,
    pub completion_digest: Option<String>,
    pub execution_ref: Option<String>,
    pub capture: Option<StoredCapture>,
    pub save_invocation: Option<Invocation>,
    pub run_invocation: Option<Invocation>,
}

#[derive(Default)]
pub struct ApplicationStoreChanges {
    pub documents: Vec<ApplicationDocument>,
    pub removed_document_ids: Vec<String>,
    pub commands: Vec<StoredCommand>,
}

/// SQLite implements these mechanical reads and one atomic CAS write. Domain
/// decisions remain in ApplicationOwner, including actor/capture association.
pub trait ApplicationRepository: Send + Sync {
    fn windows(&self, scope: &ApplicationScope) -> Result<Vec<StoredWindow>, ApplicationError>;
    fn window(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
    ) -> Result<Option<StoredWindow>, ApplicationError>;
    fn documents(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
    ) -> Result<Vec<ApplicationDocument>, ApplicationError>;
    fn command(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
        request_id: &str,
    ) -> Result<Option<StoredCommand>, ApplicationError>;
    fn commands(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
    ) -> Result<Vec<StoredCommand>, ApplicationError>;
    fn commit(
        &self,
        scope: &ApplicationScope,
        expected_revision: Option<&str>,
        window: &StoredWindow,
        changes: &ApplicationStoreChanges,
    ) -> Result<(), ApplicationError>;
    fn method_bindings(
        &self,
        scope: &ApplicationScope,
    ) -> Result<Vec<ApplicationMethodBinding>, ApplicationError>;
    fn write_method_binding(
        &self,
        scope: &ApplicationScope,
        expected_version: Option<&str>,
        binding: &ApplicationMethodBinding,
    ) -> Result<(), ApplicationError>;
    fn record_skill_read(
        &self,
        scope: &ApplicationScope,
        receipt: &ApplicationSkillReadReceipt,
    ) -> Result<(), ApplicationError>;
    fn skill_reads(
        &self,
        scope: &ApplicationScope,
        external_task_ref: Option<&str>,
    ) -> Result<Vec<ApplicationSkillReadReceipt>, ApplicationError>;
}
