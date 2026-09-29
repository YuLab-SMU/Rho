//! Ordinary native task composition over the single public owner/store/runtime.
//! Native chat and captured scientific tools use the existing scheduler. Context
//! contributions and the complete Agent UI migration remain separate work.
use crate::{
    metadata::{Failure, Metadata, decode, encoded, now},
    native_arguments::*,
};
use async_trait::async_trait;
use rho_agent_api::*;
use rho_agent_client::{NativeAgentFactory, NativeInput};
use rho_agent_native::{
    NativeTaskEndpoint, NativeTaskFailure, NativeTaskPort, NativeTaskRuntime,
    mcp::{NativeMcpLease, native_mcp_endpoint},
};
use rho_agent_owner::*;
use rho_plugin_sdk::protocol::{OperationId, PluginCall, PluginViewCaller};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Duration,
};

mod assets;

type Endpoints = Arc<Mutex<BTreeMap<String, Arc<NativeMcpLease>>>>;
pub struct NativeTasks {
    pub owner: Arc<AgentTaskOwner>,
    runtime: Arc<NativeTaskRuntime>,
    endpoints: Endpoints,
    closing: Mutex<BTreeSet<String>>,
    tools: Arc<crate::native_tools::NativeTools>,
    uploads: crate::native_uploads::Uploads,
}
impl From<AgentTaskError> for Failure {
    fn from(error: AgentTaskError) -> Self {
        let code = match &error {
            AgentTaskError::Storage(_) => "agent_storage_unavailable",
            AgentTaskError::NotFound => "not_found",
            AgentTaskError::Conflict => "conflict",
            AgentTaskError::RequestConflict => "request_conflict",
            AgentTaskError::Budget(_) => "budget_exceeded",
            AgentTaskError::InvalidInput(_) => "invalid_input",
        };
        let message = if matches!(error, AgentTaskError::Storage(_)) {
            "Original native task storage is unavailable; inspect the retained request".into()
        } else {
            error.to_string()
        };
        Self { code, message }
    }
}
impl NativeTasks {
    fn controller(metadata: &Metadata, caller: PluginViewCaller) -> AgentControllerRef {
        // Correlation is stable across renderer/backend reconnection. The fresh
        // views.caller response already validated the actual live connection;
        // these persisted labels are never reconstructed dispatch credentials.
        match caller.view {
            Some(origin) => AgentControllerRef {
                window_id: origin.window.to_string(),
                incarnation: format!("view:{}", origin.view),
            },
            None => AgentControllerRef {
                window_id: format!("agent:{}", metadata.instance.identity.instance),
                incarnation: format!("instance:{}", metadata.instance.identity.instance),
            },
        }
    }
    pub fn new(owner: Arc<AgentTaskOwner>, factory: Arc<dyn NativeAgentFactory>) -> Self {
        Self {
            runtime: NativeTaskRuntime::new(owner.clone(), factory),
            owner,
            endpoints: Default::default(),
            closing: Default::default(),
            tools: Default::default(),
            uploads: Default::default(),
        }
    }
    fn receipt(
        &self,
        scope: &AgentTaskScope,
        request: &str,
    ) -> Result<AgentCommandReceipt, Failure> {
        uuid::Uuid::parse_str(request)
            .map_err(|_| Failure::invalid("Invalid original request identity"))?;
        let mut receipt = self
            .owner
            .store
            .agent_receipt(scope, request)?
            .ok_or(AgentTaskError::NotFound)?;
        let task = self.owner.get(scope, &receipt.task_id)?;
        if task.host_incarnation != self.owner.host_incarnation
            && matches!(receipt.status.as_str(), "prepared" | "submitted")
        {
            receipt.status = "uncertain".into();
            receipt.error = Some(
                "The original native command belongs to a previous process; no work was replayed"
                    .into(),
            );
        }
        Ok(receipt)
    }
    pub async fn query(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        host: rho_plugin_sdk::HostCallClient,
    ) -> Result<Value, Failure> {
        let scope = &metadata.scope;
        match call.binding.capability.id.as_str() {
            "agent.native.tool" | "agent.native.tool.operation" => {
                crate::native_tool_observation::query(metadata, call, host).await
            }
            "agent.native.task" => {
                let input: NativeTask = decode(&call.arguments)?;
                encoded(self.owner.detail(scope, &input.task_id)?)
            }
            "agent.native.receipt" => {
                let input: NativeReceipt = decode(&call.arguments)?;
                encoded(self.receipt(scope, &input.request_id)?)
            }
            "agent.native.events" => {
                let input: NativeEvents = decode(&call.arguments)?;
                encoded(self.owner.store.agent_events(
                    scope,
                    &input.task_id,
                    input.after,
                    input.before,
                    input.limit as usize,
                )?)
            }
            "agent.native.history" => {
                let input: NativeHistory = decode(&call.arguments)?;
                if !(1..=100).contains(&input.limit)
                    || input.cursor.as_ref().is_some_and(|v| v.len() > 4096)
                {
                    return Err(Failure::invalid("Invalid native history bounds"));
                }
                encoded(
                    self.runtime
                        .history(scope, &input.task_id, input.cursor, input.limit)
                        .await?,
                )
            }
            _ => Err(Failure::invalid("Unknown native task observation")),
        }
    }
    pub async fn command(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
        host: rho_plugin_sdk::HostCallClient,
    ) -> Result<Value, Failure> {
        if self.runtime.is_stopped() {
            return Err(Failure::invalid("This native Agent instance is closing"));
        }
        let input: NativeAction = decode(&call.arguments)?;
        let controller = Self::controller(metadata, caller.clone());
        let request = AgentTaskRequest {
            project_root: metadata.scope.project.clone(),
            window: controller,
            request_id: input.request_id,
            command: input.command.into(),
        };
        crate::native_controller::check_takeover(metadata, call, &caller, &request, &host).await?;
        let tools =
            crate::native_selection::capture(metadata, call, &caller, &request, input.tools, &host)
                .await?;
        let at = now();
        let origin = AgentNativeCommandOrigin {
            operation: OperationId::new(call.operation_id.as_deref().ok_or_else(|| {
                Failure::invalid("Native commands require their original Operation")
            })?)
            .map_err(|_| Failure::invalid("Invalid native Operation identity"))?,
            request: call.request.clone(),
            binding: call.binding.clone(),
            project_root: metadata.scope.project.clone(),
            principal: metadata.scope.principal.clone(),
            scopes: call.scopes.clone(),
            tools,
        };
        // No await between the caller observation, durable admission and launch.
        let admission = self.tools.admit(
            self.owner.clone(),
            &metadata.scope,
            &request,
            origin,
            host,
            at,
        )?;
        let task_id = admission.task.task.task_id.clone();
        let repeated = admission.repeated;
        let generation = admission.task.attachment.generation;
        let native = admission.native;
        if native && !repeated {
            let port = Arc::new(InputPort {
                owner: self.owner.clone(),
                endpoints: self.endpoints.clone(),
                tools: self.tools.clone(),
            });
            let native_result = async {
                if let Some(work) =
                    self.runtime
                        .launch(metadata.scope.clone(), request.clone(), admission, port)
                {
                    work.await.map_err(|_| {
                        Failure {
                    code: "native_outcome_uncertain",
                    message:
                        "Original native work ended without a receipt; inspect it before continuing"
                            .into(),
                }
                    })?;
                }
                // launch can finish after prompt acceptance while the native turn is
                // still running. Keep this parent retained until its observed outcome.
                loop {
                    let receipt = self.receipt(&metadata.scope, &request.request_id)?;
                    if !matches!(receipt.status.as_str(), "prepared" | "submitted") {
                        break;
                    }
                    if self.runtime.is_stopped() {
                        return Err(Failure {
                            code: "native_outcome_uncertain",
                            message: "Native shutdown did not confirm this original command".into(),
                        });
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Ok::<_, Failure>(())
            }
            .await;
            // Fence new tools and retain every accepted child even when the
            // model/native wait failed or Stop settled the native turn first.
            let tools_result = self.tools.finish(&task_id, &request.request_id).await;
            tools_result?;
            native_result?;
        } else if !repeated
            && matches!(
                request.command,
                AgentTaskCommand::TakeOver { stop: false, .. }
            )
        {
            self.runtime
                .rebind(&task_id, request.window.clone(), generation)
                .await;
        }
        let receipt = self.receipt(&metadata.scope, &request.request_id)?;
        if !repeated && receipt.status != "succeeded" {
            return Err(Failure {
                code: if receipt.status == "uncertain" { "native_outcome_uncertain" } else { "native_command_failed" },
                message: "The original native command has no successful receipt; inspect its retained task outcome".into(),
            });
        }
        encoded(AgentTaskCommandResult {
            receipt,
            detail: self.owner.detail(&metadata.scope, &task_id)?,
        })
    }
    pub async fn upload(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let input: NativeUpload = decode(&call.arguments)?;
        if input.data.len() > 524288 {
            return Err(Failure::invalid(
                "This upload exceeds the single-message attachment limit",
            ));
        }
        let at = now();
        let controller = Self::controller(metadata, caller);
        let request = AgentTaskRequest {
            project_root: metadata.scope.project.clone(),
            window: controller,
            request_id: input.request_id,
            command: AgentTaskCommand::AddAsset {
                control: input.control,
                name: input.name,
                mime_type: input.mime_type,
                data: input.data,
            },
        };
        if self.runtime.is_stopped() {
            return Err(Failure::invalid("This native Agent instance is closing"));
        }
        let admission = self.owner.admit(&metadata.scope, &request, at)?;
        self.finish_upload(metadata, request, admission).await
    }

    pub async fn close(&self, scope: &AgentTaskScope) -> Result<(), Failure> {
        let tasks = self.runtime.active_ids(scope).await;
        self.closing
            .lock()
            .map_err(|_| Failure::invalid("Native process cleanup is unavailable"))?
            .extend(tasks);
        self.runtime.close().await;
        let tools_result = self.tools.close().await;
        let leases: Vec<_> = self
            .endpoints
            .lock()
            .map_err(|_| Failure::invalid("Native endpoint cleanup is unavailable"))?
            .values()
            .cloned()
            .collect();
        for lease in leases {
            lease
                .close()
                .await
                .map_err(|_| Failure::invalid("Native endpoint cleanup is unconfirmed"))?;
        }
        let tasks: Vec<_> = self
            .closing
            .lock()
            .map_err(|_| Failure::invalid("Native process cleanup is unavailable"))?
            .iter()
            .cloned()
            .collect();
        // A failed explicit disconnect or replacement can remove a live entry
        // while its persisted process proof remains unresolved. The live map
        // alone cannot establish that this instance is safe to release.
        let mut before = None;
        let mut seen = 0usize;
        loop {
            let page = self
                .owner
                .store
                .agent_tasks(scope, None, before.as_deref(), 128)?;
            for task in &page {
                if !task.native_quiet {
                    return Err(Failure::invalid(
                        "Original native process cleanup is unconfirmed",
                    ));
                }
            }
            seen += page.len();
            if page.len() < 128 {
                break;
            }
            if seen > MAX_AGENT_TASKS {
                return Err(Failure::invalid(
                    "Native process cleanup observation exceeds its task budget",
                ));
            }
            let last = page.last().unwrap();
            before = Some(format!("{}:{}", last.task.created_at_ms, last.task.task_id));
        }
        for id in tasks {
            if !self.owner.get(scope, &id)?.native_quiet {
                return Err(Failure::invalid(
                    "Original native process cleanup is unconfirmed",
                ));
            }
        }
        self.endpoints
            .lock()
            .map_err(|_| Failure::invalid("Native endpoint cleanup is unavailable"))?
            .clear();
        self.closing
            .lock()
            .map_err(|_| Failure::invalid("Native process cleanup is unavailable"))?
            .clear();
        tools_result
    }
}
struct InputPort {
    owner: Arc<AgentTaskOwner>,
    endpoints: Endpoints,
    tools: Arc<crate::native_tools::NativeTools>,
}
#[async_trait]
impl NativeTaskPort for InputPort {
    async fn input(
        &self,
        scope: &AgentTaskScope,
        task: &StoredAgentTask,
        draft: &AgentTaskDraft,
    ) -> Result<Vec<NativeInput>, NativeTaskFailure> {
        if !draft.content.context.is_empty() {
            return Err(NativeTaskFailure::before(
                "Contributed context capture is not yet connected; the original draft was preserved",
            ));
        }
        let mut parts = vec![NativeInput::Text(draft.content.text.clone())];
        if let Some(context) = self
            .tools
            .context(&task.task.task_id)
            .map_err(NativeTaskFailure::before)?
        {
            parts.push(NativeInput::Text(context));
        }
        for id in &draft.content.assets {
            let (asset, bytes) = self
                .owner
                .store
                .agent_asset(scope, &task.task.task_id, id)?;
            if asset.bytes != bytes.len() as u64
                || asset.sha256 != format!("{:x}", Sha256::digest(&bytes))
            {
                return Err(NativeTaskFailure::before(
                    "Original attachment integrity could not be verified",
                ));
            }
            if asset.mime_type.starts_with("image/") {
                parts.push(NativeInput::Image {
                    mime_type: asset.mime_type,
                    data: bytes,
                });
            } else {
                parts.push(NativeInput::Resource {
                    uri: format!("rho://attachments/{}/{}", task.task.task_id, asset.asset_id),
                    text: String::from_utf8(bytes).map_err(|_| {
                        NativeTaskFailure::before(
                            "The attachment is not supported text/image input",
                        )
                    })?,
                    mime_type: asset.mime_type,
                });
            }
        }
        Ok(parts)
    }
    async fn endpoint(
        &self,
        _: &AgentTaskScope,
        task: &StoredAgentTask,
    ) -> Result<NativeTaskEndpoint, NativeTaskFailure> {
        let prior = self
            .endpoints
            .lock()
            .map_err(|_| NativeTaskFailure::before("Endpoint ownership is unavailable"))?
            .get(&task.task.task_id)
            .cloned();
        if let Some(prior) = prior {
            prior.close().await.map_err(NativeTaskFailure::before)?;
        }
        let endpoint = native_mcp_endpoint(
            self.tools.port(task.task.task_id.clone()),
            crate::native_tools::catalog(),
        )
        .await
        .map_err(NativeTaskFailure::before)?;
        let mut endpoints = self
            .endpoints
            .lock()
            .map_err(|_| NativeTaskFailure::before("Endpoint ownership is unavailable"))?;
        endpoints.retain(|_, lease| !lease.is_closed());
        endpoints.insert(task.task.task_id.clone(), endpoint.lease);
        Ok(endpoint.endpoint)
    }
}
