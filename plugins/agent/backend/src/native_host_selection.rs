//! Inspect native Host metadata without disguising it as a plugin provider.
use crate::{
    manifest,
    metadata::{Failure, Metadata, decode},
    native_selection::{query, require},
};
use rho_agent_api::*;
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::json;

pub(crate) async fn capture(
    metadata: &Metadata,
    call: &PluginCall,
    selection: AgentNativeToolSelection,
    host: &HostCallClient,
) -> Result<AgentNativeToolGrant, Failure> {
    let AgentNativeToolTarget::Host {
        project,
        capability,
        fixed_arguments,
    } = &selection.target
    else {
        return Err(Failure::invalid("Expected an explicit native Host target"));
    };
    if project != &call.binding.project {
        return Err(Failure::invalid("Host tool belongs to another project"));
    }
    require(
        metadata,
        call,
        &manifest::key("host.core_contract"),
        &["plugins.read".into()].into(),
    )?;
    let value = query(
        host,
        &call.request,
        manifest::key("host.core_contract"),
        json!({"capability":capability}),
    )
    .await?;
    let contract: HostCapabilityContract = decode(&value)?;
    if &contract.project != project || &contract.capability != capability {
        return Err(Failure::invalid(
            "Host contract differs from the selected target",
        ));
    }
    let kind = match contract.kind {
        CapabilityKind::Query => AgentNativeToolKind::Query,
        CapabilityKind::Operation => AgentNativeToolKind::Operation,
        _ => {
            return Err(Failure::invalid(
                "Host tools accept Query and Operation only",
            ));
        }
    };
    require(metadata, call, capability, &contract.required_scopes)?;
    if kind == AgentNativeToolKind::Operation {
        for name in ["operation.get", "plugins.delegated_operation"] {
            require(
                metadata,
                call,
                &manifest::key(name),
                &["operation.read".into()].into(),
            )?;
        }
    }
    let input_schema =
        rho_agent_owner::native_host_tool_schema(&contract.input_schema, fixed_arguments)?;
    Ok(AgentNativeToolGrant {
        selection,
        kind,
        description: contract.description,
        input_schema,
        required_scopes: contract.required_scopes,
    })
}
