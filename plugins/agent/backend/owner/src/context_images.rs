//! Captured image identities belong to the original Send; bytes live separately.
use crate::AgentTaskError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_CONTEXT_IMAGE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_PROJECT_CONTEXT_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentContextImage {
    pub reference: serde_json::Value,
    pub sha256: String,
    pub mime_type: String,
    pub bytes: u64,
}
impl AgentContextImage {
    pub fn validate(&self) -> Result<(), AgentTaskError> {
        if !(1..=MAX_CONTEXT_IMAGE_BYTES).contains(&self.bytes)
            || !matches!(self.mime_type.as_str(), "image/png" | "image/jpeg")
            || self.sha256.len() != 71
            || !self.sha256.starts_with("sha256:")
            || !self.sha256[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !self.reference.is_object()
            || serde_json::to_vec(&self.reference)
                .map_err(|e| AgentTaskError::Storage(e.to_string()))?
                .len()
                > 4096
        {
            return Err(AgentTaskError::InvalidInput(
                "Invalid captured context image identity".into(),
            ));
        }
        Ok(())
    }
    pub fn verify(&self, bytes: &[u8]) -> Result<(), AgentTaskError> {
        self.validate()?;
        if self.bytes != bytes.len() as u64
            || self.sha256 != format!("sha256:{:x}", Sha256::digest(bytes))
        {
            return Err(AgentTaskError::InvalidInput(
                "Captured context image bytes differ from their identity".into(),
            ));
        }
        Ok(())
    }
}
