//! Durable resource identity beside the original receipt, without attachment bytes.
use crate::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_AGENT_ASSET_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PROJECT_ASSET_IMPORT_BYTES: usize = 16 * 1024 * 1024;

pub fn validate_asset_import(input: &AgentResourceAssetUpload) -> Result<(), AgentTaskError> {
    let id = uuid::Uuid::parse_str(&input.request_id)
        .map_err(|_| invalid("Invalid attachment request ID"))?;
    if id.to_string() != input.request_id
        || input.name.is_empty()
        || input.name.len() > 240
        || input.name.chars().any(char::is_control)
        || input.reference.bytes > MAX_AGENT_ASSET_BYTES as u64
    {
        return Err(invalid("Invalid attachment identity, name or byte length"));
    }
    // The public declaration owns media-type and byte-bound validation.
    input
        .validate_resource()
        .map_err(|_| invalid("Invalid attachment resource declaration"))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAgentAssetImport {
    pub project: String,
    pub principal: String,
    pub input: AgentResourceAssetUpload,
    pub controller: AgentControllerRef,
    pub request_digest: String,
    pub input_digest: String,
}
impl StoredAgentAssetImport {
    pub fn validate(
        &self,
        scope: &AgentTaskScope,
        receipt: &AgentCommandReceipt,
    ) -> Result<(), AgentTaskError> {
        validate_asset_import(&self.input)?;
        if self.project != scope.project
            || self.principal != scope.principal
            || receipt.request_id != self.input.request_id
            || receipt.task_id != self.input.control.task_id
            || receipt.command != "add_asset"
            || receipt.request_digest != self.request_digest
            || receipt.input_digest != self.input_digest
            || self.request_digest.len() != 64
            || self.input_digest.len() != 64
        {
            return Err(AgentTaskError::RequestConflict);
        }
        if serde_json::to_vec(self)
            .map_err(|e| AgentTaskError::Storage(e.to_string()))?
            .len()
            > 16 * 1024
        {
            return Err(AgentTaskError::Budget(
                "Attachment import identity exceeds its byte budget".into(),
            ));
        }
        Ok(())
    }
}
impl AgentTaskOwner {
    /// Inspect an identical original import before touching the resource. A missing
    /// capture with an existing receipt is a conflict, never permission to replay.
    pub fn prepare_asset_import(
        &self,
        scope: &AgentTaskScope,
        input: &AgentResourceAssetUpload,
        controller: &AgentControllerRef,
    ) -> Result<Option<AgentTaskAdmission>, AgentTaskError> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| invalid("Agent metadata lock poisoned"))?;
        validate_asset_import(input)?;
        if let Some(receipt) = self.store.agent_receipt(scope, &input.request_id)? {
            let capture = self
                .store
                .agent_asset_import(scope, &input.request_id)?
                .ok_or(AgentTaskError::RequestConflict)?;
            capture.validate(scope, &receipt)?;
            if &capture.input != input || &capture.controller != controller {
                return Err(AgentTaskError::RequestConflict);
            }
            return Ok(Some(AgentTaskAdmission {
                task: self.get(scope, &receipt.task_id)?,
                draft: self.store.agent_draft(scope, &receipt.task_id)?,
                receipt,
                repeated: true,
                native: false,
            }));
        }
        let task = self.get(scope, &input.control.task_id)?;
        if task.attachment.generation != input.control.generation {
            return Err(AgentTaskError::Conflict);
        }
        if task.task.archived
            || task.attachment.control_frozen
            || task.attachment.controller.window_id != controller.window_id
        {
            return Err(invalid(
                "This task cannot accept an attachment under the current control",
            ));
        }
        Ok(None)
    }

    /// Bytes already came through a granted resource read. Recheck the complete
    /// digest here and perform the ordinary task preconditions under the owner lock.
    pub fn admit_asset_import(
        &self,
        scope: &AgentTaskScope,
        input: AgentResourceAssetUpload,
        controller: AgentControllerRef,
        bytes: &[u8],
        now: u64,
    ) -> Result<(AgentTaskRequest, AgentTaskAdmission), AgentTaskError> {
        validate_asset_import(&input)?;
        if bytes.len() as u64 != input.reference.bytes
            || format!("sha256:{:x}", Sha256::digest(bytes)) != input.reference.digest.as_str()
        {
            return Err(invalid(
                "Attachment content differs from its captured resource",
            ));
        }
        let request = AgentTaskRequest {
            project_root: scope.project.clone(),
            window: controller.clone(),
            request_id: input.request_id.clone(),
            command: AgentTaskCommand::AddAsset {
                control: input.control.clone(),
                name: input.name.clone(),
                mime_type: input.reference.media_type.clone(),
                data: STANDARD.encode(bytes),
            },
        };
        let capture = StoredAgentAssetImport {
            project: scope.project.clone(),
            principal: scope.principal.clone(),
            input,
            controller,
            request_digest: String::new(),
            input_digest: String::new(),
        };
        let admission = self.admit_inner(scope, &request, now, None, Some(capture))?;
        Ok((request, admission))
    }
}
