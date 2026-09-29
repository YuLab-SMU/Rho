use super::*;
use crate::{manifest, native_selection, server};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_sdk::{
    HostCallClient,
    protocol::{MAX_RESOURCE_READ_BYTES, ResourceChunk, ResourceRead},
};
use serde_json::json;

impl NativeTasks {
    fn upload_controller(
        &self,
        metadata: &Metadata,
        upload: &crate::native_uploads::Upload,
        caller: PluginViewCaller,
    ) -> Result<AgentControllerRef, Failure> {
        upload.validate()?;
        if self.runtime.is_stopped() {
            return Err(Failure::invalid("This native Agent instance is closing"));
        }
        let controller = Self::controller(metadata, caller);
        let task = self.owner.get(&metadata.scope, &upload.control.task_id)?;
        if task.attachment.generation != upload.control.generation
            || task.attachment.controller != controller
            || task.attachment.control_frozen
            || task.task.archived
        {
            return Err(Failure::invalid(
                "The attachment's original task controller is no longer editable",
            ));
        }
        Ok(controller)
    }
    pub fn stage_upload(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let input: crate::native_uploads::Chunk = decode(&call.arguments)?;
        let controller = self.upload_controller(metadata, &input.upload, caller)?;
        if input.data.len() > 87384 {
            return Err(Failure::invalid("Attachment chunk exceeds its byte limit"));
        }
        let bytes = STANDARD
            .decode(input.data)
            .map_err(|_| Failure::invalid("Invalid attachment chunk encoding"))?;
        encoded(
            self.uploads
                .stage(input.upload, controller, input.offset, &bytes)?,
        )
    }
    pub async fn finish_staged_upload(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let input: crate::native_uploads::Finish = decode(&call.arguments)?;
        let controller = self.upload_controller(metadata, &input.upload, caller)?;
        let bytes = self.uploads.take(&input.upload, &controller)?;
        let request = AgentTaskRequest {
            project_root: metadata.scope.project.clone(),
            window: controller,
            request_id: input.upload.request_id,
            command: AgentTaskCommand::AddAsset {
                control: input.upload.control,
                name: input.upload.name,
                mime_type: input.upload.mime_type,
                data: STANDARD.encode(bytes),
            },
        };
        // Same original owner receipt/digest as a bounded inline upload. No
        // await separates fresh native preconditions from owner admission.
        let admission = self.owner.admit(&metadata.scope, &request, now())?;
        self.finish_upload(metadata, request, admission).await
    }

    pub async fn import_asset(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
        host: HostCallClient,
    ) -> Result<Value, Failure> {
        let input: AgentResourceAssetUpload = decode(&call.arguments)?;
        native_selection::require(
            metadata,
            call,
            &manifest::key("resources.read"),
            &["resources.read".into()].into(),
        )?;
        let controller = Self::controller(metadata, caller.clone());
        if let Some(original) =
            self.owner
                .prepare_asset_import(&metadata.scope, &input, &controller)?
        {
            // No source read or native launch, even after process reconnection.
            return self.upload_result(metadata, &input.request_id, &original.task.task.task_id);
        }
        if self.runtime.is_stopped() {
            return Err(Failure::invalid("This native Agent instance is closing"));
        }
        let mut bytes = Vec::with_capacity(input.reference.bytes as usize);
        loop {
            let offset = bytes.len() as u64;
            let read = ResourceRead {
                reference: input.reference.clone(),
                offset,
                limit: MAX_RESOURCE_READ_BYTES,
            };
            let chunk: ResourceChunk = decode(
                &native_selection::query(
                    &host,
                    &call.request,
                    manifest::key("resources.read"),
                    encoded(read)?,
                )
                .await?,
            )?;
            let expected =
                (input.reference.bytes - offset).min(MAX_RESOURCE_READ_BYTES as u64) as usize;
            let next = (offset + (expected as u64) < input.reference.bytes)
                .then_some(offset + expected as u64);
            if chunk.reference != input.reference
                || chunk.offset != offset
                || chunk.next != next
                || chunk.base64.len() > expected.div_ceil(3) * 4
            {
                return Err(Failure::invalid(
                    "Attachment resource range differs from the captured input",
                ));
            }
            let part = STANDARD
                .decode(chunk.base64)
                .map_err(|_| Failure::invalid("Invalid attachment resource encoding"))?;
            if part.len() != expected {
                return Err(Failure::invalid("Incomplete attachment resource range"));
            }
            bytes.extend_from_slice(&part);
            if next.is_none() {
                break;
            }
        }
        let pending = host
            .begin(
                native_selection::read_id(),
                call.request.clone(),
                manifest::key("views.caller"),
                json!({}),
            )
            .map_err(|_| Failure::invalid("Attachment caller revalidation is unavailable"))?;
        if server::caller(pending.receive().await)? != caller {
            return Err(Failure::invalid(
                "The native caller changed before attachment admission",
            ));
        }
        if self.runtime.is_stopped() {
            return Err(Failure::invalid("This native Agent instance is closing"));
        }
        let (request, admission) =
            self.owner
                .admit_asset_import(&metadata.scope, input, controller, &bytes, now())?;
        self.finish_upload(metadata, request, admission).await
    }
    pub(super) async fn finish_upload(
        &self,
        metadata: &Metadata,
        request: AgentTaskRequest,
        admission: AgentTaskAdmission,
    ) -> Result<Value, Failure> {
        let task_id = admission.task.task.task_id.clone();
        let port = Arc::new(InputPort {
            owner: self.owner.clone(),
            endpoints: self.endpoints.clone(),
            tools: self.tools.clone(),
        });
        if let Some(work) =
            self.runtime
                .launch(metadata.scope.clone(), request.clone(), admission, port)
        {
            work.await.map_err(|_| Failure {
                code: "native_outcome_uncertain",
                message: "Original attachment outcome is unconfirmed".into(),
            })?;
        }
        self.upload_result(metadata, &request.request_id, &task_id)
    }
    fn upload_result(
        &self,
        metadata: &Metadata,
        request: &str,
        task_id: &str,
    ) -> Result<Value, Failure> {
        let receipt = self.receipt(&metadata.scope, request)?;
        if receipt.status != "succeeded" {
            return Err(Failure {
                code: if receipt.status == "failed" { "native_command_failed" } else { "native_outcome_uncertain" },
                message: "The original attachment has no successful receipt; inspect its retained outcome".into(),
            });
        }
        encoded(AgentTaskCommandResult {
            receipt,
            detail: self.owner.detail(&metadata.scope, task_id)?,
        })
    }
}
