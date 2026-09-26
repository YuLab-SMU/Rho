use crate::{RuntimeInstallationIdentity, RuntimeProcessIdentity};
use rho_plugin_protocol::{ContentDigest, OperationId, ProviderBinding, ResourceReference};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Exact Environment provider and original successful realization. Selecting it
/// does not start R; creation performs explicit verification under this binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct REnvironmentSelection {
    pub binding: ProviderBinding,
    pub realization: OperationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CreateRSession {
    pub environment: REnvironmentSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RSessionEnvironment {
    pub selection: REnvironmentSelection,
    pub source: ProviderBinding,
    pub report: ResourceReference,
    pub verification: OperationId,
    pub verification_report: ResourceReference,
    pub library_path: String,
    pub library_digest: ContentDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RSessionCreated {
    pub operation_id: OperationId,
    pub session_id: String,
    pub process: Option<RuntimeProcessIdentity>,
    pub installation: Option<RuntimeInstallationIdentity>,
    pub project_root: String,
    pub environment: Option<RSessionEnvironment>,
}
