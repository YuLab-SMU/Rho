//! Browser transport delegates through the same Host ports as CLI and MCP.
use crate::*;
use rho_contract::{CapabilityRef, HostRequest, QueryRequest};
use rho_plugin_protocol::*;
use serde_json::{Value, json};

impl NextHost {
    pub fn plugin_view_asset(
        &self,
        connection: &str,
        token: &str,
        path: &str,
    ) -> Result<rho_plugins::PluginViewAsset, OperationError> {
        self.runtime
            .plugins
            .as_ref()
            .ok_or_else(|| OperationError::Unavailable("plugin views are not composed".into()))?
            .view_asset(connection, token, path)
    }
    pub async fn dispatch_plugin_view(
        &self,
        parent: &CallContext,
        window: &str,
        token: &str,
        message: PluginViewMessage,
    ) -> Result<Value, OperationError> {
        if message.protocol_version != PLUGIN_PROTOCOL_VERSION
            || serde_json::to_vec(&message)
                .map_err(|e| OperationError::InvalidInput(e.to_string()))?
                .len()
                > MAX_CONTROL_BYTES
        {
            return Err(OperationError::InvalidInput(
                "invalid view protocol or oversized message".into(),
            ));
        }
        let service =
            self.runtime.plugins.as_ref().ok_or_else(|| {
                OperationError::Unavailable("plugin views are not composed".into())
            })?;
        let cap = match &message.body {
            PluginViewRequest::Query { capability, .. }
            | PluginViewRequest::Control { capability, .. }
            | PluginViewRequest::Invoke { capability, .. } => Some(CapabilityRef::new(
                capability.id.as_str(),
                capability.version.try_into().map_err(|_| {
                    OperationError::InvalidInput("capability version out of range".into())
                })?,
            )?),
            _ => None,
        };
        let mut context = service
            .view_context(
                parent,
                message.connection.as_str(),
                token,
                window,
                &message.view,
                message.sequence,
                cap.as_ref(),
            )
            .await?;
        service.check_view_close_fence(&message.view, &message.body)?;
        let cancel = matches!(&message.body, PluginViewRequest::Cancel { .. });
        let request = match message.body {
            body @ (PluginViewRequest::RegisterCloseHandler { .. }
            | PluginViewRequest::ObserveLifecycle { .. }
            | PluginViewRequest::PrepareClose { .. }
            | PluginViewRequest::RefuseClose { .. }) => {
                if !parent.scopes.contains(rho_plugins::PLUGINS_RUN_SCOPE) {
                    return Err(OperationError::InvalidInput("view lifecycle requires the parent's existing view authority".into()));
                }
                return Ok(json!(service.cooperate_with_view_close(&context, &message.view, &body)?));
            }
            PluginViewRequest::BeginTextCopy
            | PluginViewRequest::FinishTextCopy { .. }
            | PluginViewRequest::CancelTextCopy { .. } => {
                // Intrinsic presentation cooperation, bound to this exact live
                // view. Only its containing browser can perform the native copy;
                // this acknowledgement never claims a clipboard side effect.
                if !parent.scopes.contains(rho_plugins::PLUGINS_RUN_SCOPE) {
                    return Err(OperationError::InvalidInput(
                        "text copy requires the parent's existing view authority".into(),
                    ));
                }
                return Ok(json!({"authorized_view":message.view}));
            }
            PluginViewRequest::Control { arguments, .. } => HostRequest::Control(rho_contract::ControlRequest {
                capability: cap.unwrap(), arguments,
            }),
            PluginViewRequest::Query { arguments, .. } => {
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: cap.unwrap(),
                    arguments,
                })
            }
            PluginViewRequest::Invoke {
                request_id,
                arguments,
                preconditions,
                ..
            } => HostRequest::Invoke(rho_contract::InvokeRequest {
                invocation: Invocation {
                    client_request_id: rho_plugins::content_digest(
                        format!("{}:{}", message.view, request_id).as_bytes(),
                    )
                    .to_string(),
                    capability: cap.unwrap(),
                    arguments,
                    preconditions: serde_json::from_value(json!(preconditions))
                        .map_err(|e| OperationError::InvalidInput(e.to_string()))?,
                },
                return_after_acceptance: Some(true),
            }),
            PluginViewRequest::GetOperation { operation_id }
            | PluginViewRequest::Cancel { operation_id } => {
                let id = rho_contract::OperationId::new(operation_id)?;
                let record = self
                    .runtime
                    .gateway
                    .owner_record(&context, &id)
                    .await?
                    .ok_or_else(|| OperationError::NotFound(id.as_str().into()))?;
                if record.operation.caller != context.caller {
                    return Err(OperationError::NotFound(id.as_str().into()));
                }
                // Reading the result of this view's own accepted command uses
                // only the parent's existing read authority. Cancellation keeps
                // its native rule and does not introduce a read requirement.
                if !cancel && parent.scopes.contains("operation.read") {
                    context.scopes.insert("operation.read".into());
                }
                if cancel {
                    HostRequest::RequestCancellation {
                        operation_id: id,
                        only_if_pending: Some(false),
                    }
                } else {
                    HostRequest::GetOperation { operation_id: id }
                }
            }
            PluginViewRequest::SetState {
                expected_version,
                state,
            } => {
                // Intrinsic self-state authority cannot name another view or any
                // other capability. The original parent still needs plugins.run.
                context.scopes = parent
                    .scopes
                    .intersection(&[rho_plugins::PLUGINS_RUN_SCOPE.to_string()].into())
                    .cloned()
                    .collect();
                HostRequest::Invoke(rho_contract::InvokeRequest {
                    invocation: Invocation {
                        client_request_id: rho_plugins::content_digest(
                            format!("{}:{}", message.view, message.request).as_bytes(),
                        )
                        .to_string(),
                        capability: CapabilityRef::new("views.update", 1)?,
                        arguments: json!(UpdatePluginView {
                            view: message.view,
                            expected_version,
                            state
                        }),
                        preconditions: vec![],
                    },
                    return_after_acceptance: Some(false),
                })
            }
        };
        self.dispatch(&context, request).await
    }
}
