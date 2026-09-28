//! Recovery reads correlate the original child; they never re-dispatch it or
//! turn a missing journal acknowledgement into proof of no scientific effect.
use crate::{
    manifest,
    metadata::{Failure, Metadata, decode, encoded},
    native_arguments::NativeToolReceipt,
    native_selection,
};
use rho_agent_api::*;
use rho_agent_owner::AgentTaskError;
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::{Value, json};
pub(crate) async fn query(
    metadata: &Metadata,
    call: &PluginCall,
    host: HostCallClient,
) -> Result<Value, Failure> {
    let input: NativeToolReceipt = decode(&call.arguments)?;
    for id in [&input.send_request, &input.tool_request] {
        uuid::Uuid::parse_str(id)
            .map_err(|_| Failure::invalid("Invalid original native tool identity"))?;
    }
    let tool = metadata
        .native
        .owner
        .store
        .agent_native_tool(&metadata.scope, &input.send_request, &input.tool_request)?
        .ok_or(AgentTaskError::NotFound)?;
    if call.binding.capability.id.as_str() == "agent.native.tool" {
        return encoded(tool);
    }
    if tool.kind != AgentNativeToolKind::Operation {
        return Err(Failure::invalid(
            "This native tool is not a scientific Operation",
        ));
    }
    for name in ["plugins.delegated_operation", "operation.get"] {
        native_selection::require(
            metadata,
            call,
            &manifest::key(name),
            &["operation.read".into()].into(),
        )?;
    }
    let capture = metadata
        .native
        .owner
        .store
        .agent_native_admission(&metadata.scope, &input.send_request)?
        .ok_or(AgentTaskError::NotFound)?;
    let observed = native_selection::observe(
        &host,
        &call.request,
        manifest::key("plugins.delegated_operation"),
        json!({"parent_operation":capture.origin.operation,"request":tool.request}),
    )
    .await?;
    if !matches!(
        observed["status"].as_str(),
        Some("ready" | "busy" | "unavailable")
    ) || !matches!(
        observed["completeness"].as_str(),
        Some("complete" | "partial" | "cached" | "unavailable")
    ) {
        return Err(Failure::invalid(
            "Invalid original delegated-operation observation",
        ));
    }
    let partial = || json!({"send_request":input.send_request,"tool_request":input.tool_request,"completeness":"partial","request":tool.request,"operation":null});
    if observed["status"] != "ready" || observed["completeness"] != "complete" {
        return Ok(partial());
    }
    let found: PluginDelegatedOperation = decode(&observed["data"])?;
    let Some(id) = found.operation_id else {
        return Ok(partial());
    };
    if tool.operation.as_ref().is_some_and(|saved| saved != &id) {
        return Err(Failure::invalid(
            "Original tool and scientific journal disagree",
        ));
    }
    let data = native_selection::query(
        &host,
        &call.request,
        manifest::key("operation.get"),
        json!({"operation_id":id}),
    )
    .await?;
    let (found, result) = crate::native_result::operation_result(
        &metadata.scope.project,
        &capture.origin.binding.provider.instance,
        &capture.origin.operation,
        &tool.native_request,
        &data["record"],
    )
    .map_err(|_| {
        Failure::invalid("Original scientific record differs from the retained native tool")
    })?;
    if found != id {
        return Err(Failure::invalid(
            "Scientific lookup returned another original identity",
        ));
    }
    Ok(
        json!({"send_request":input.send_request,"tool_request":input.tool_request,"completeness":"complete","request":tool.request,"operation":result}),
    )
}
