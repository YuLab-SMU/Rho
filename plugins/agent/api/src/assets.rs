//! Attachment imports carry a native resource identity, never file paths or bytes.
use crate::AgentTaskControl;
use rho_plugin_protocol::ResourceReference;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentResourceAssetUpload {
    #[schemars(length(min = 36, max = 36))]
    pub request_id: String,
    pub control: AgentTaskControl,
    #[schemars(length(min = 1, max = 240))]
    pub name: String,
    pub reference: ResourceReference,
}

impl AgentResourceAssetUpload {
    pub fn validate_resource(&self) -> Result<(), rho_plugin_protocol::ProtocolError> {
        rho_plugin_protocol::ResourceDeclaration {
            digest: self.reference.digest.clone(),
            media_type: self.reference.media_type.clone(),
            bytes: self.reference.bytes,
        }
        .validate()
    }
}
