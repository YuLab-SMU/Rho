//! Capture exact public provider manifests or native Host contracts before Send.
use crate::{
    manifest,
    metadata::{Failure, Metadata, decode},
    server,
};
use rho_agent_api::*;
use rho_agent_owner::{AgentTaskError, MAX_NATIVE_TOOLS};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) async fn capture(
    metadata: &Metadata,
    call: &PluginCall,
    caller: &PluginViewCaller,
    request: &AgentTaskRequest,
    selected: Vec<AgentNativeToolSelection>,
    host: &HostCallClient,
) -> Result<Vec<AgentNativeToolGrant>, Failure> {
    if selected.len() > MAX_NATIVE_TOOLS
        || (!selected.is_empty() && !matches!(request.command, AgentTaskCommand::Send { .. }))
    {
        return Err(Failure::invalid(
            "Only Send accepts a bounded explicit tool selection",
        ));
    }
    if let Some(original) = metadata
        .native
        .owner
        .store
        .agent_native_admission(&metadata.scope, &request.request_id)?
    {
        if original
            .origin
            .tools
            .iter()
            .map(|t| &t.selection)
            .collect::<Vec<_>>()
            != selected.iter().collect::<Vec<_>>()
        {
            return Err(AgentTaskError::RequestConflict.into());
        }
        return Ok(original.origin.tools);
    }
    capture_selected(metadata, call, caller, selected, host).await
}

/// Shared capture for native and built-in model runs. Provider identity, schemas
/// and scopes always come from the immutable installed manifest.
pub(crate) async fn capture_selected(
    metadata: &Metadata,
    call: &PluginCall,
    caller: &PluginViewCaller,
    selected: Vec<AgentNativeToolSelection>,
    host: &HostCallClient,
) -> Result<Vec<AgentNativeToolGrant>, Failure> {
    if selected.len() > MAX_NATIVE_TOOLS {
        return Err(Failure::invalid("Too many selected workspace tools"));
    }
    if selected.is_empty() {
        return Ok(vec![]);
    }
    let mut revisions = BTreeMap::new();
    let mut tools = vec![];
    for selection in selected {
        if matches!(&selection.target, AgentNativeToolTarget::Host { .. }) {
            tools.push(
                crate::native_host_selection::capture(metadata, call, selection, host).await?,
            );
            continue;
        }
        let AgentNativeToolTarget::Provider { binding } = &selection.target else {
            unreachable!()
        };
        require(
            metadata,
            call,
            &manifest::key("plugins.inspect"),
            &["plugins.read".into()].into(),
        )?;
        if binding.project != call.binding.project || binding.provider == call.binding.provider {
            return Err(Failure::invalid(
                "Tool selection must name another provider in this project",
            ));
        }
        let revision = &binding.provider.revision;
        if !revisions.contains_key(revision) {
            let result = query(
                host,
                &call.request,
                manifest::key("plugins.inspect"),
                json!({"revision":revision}),
            )
            .await?;
            let inspected: PluginInspection = decode(&result)?;
            if &inspected.summary.revision != revision
                || inspected.manifest.id != binding.provider.plugin
                || !inspected
                    .artifacts
                    .iter()
                    .any(|a| a.id == binding.provider.artifact)
            {
                return Err(Failure::invalid(
                    "Tool manifest differs from its exact selected version",
                ));
            }
            revisions.insert(revision.clone(), inspected);
        }
        let inspected = &revisions[revision];
        if inspected.manifest.id != binding.provider.plugin
            || !inspected
                .artifacts
                .iter()
                .any(|a| a.id == binding.provider.artifact)
        {
            return Err(Failure::invalid(
                "Tool artifact differs from the original selection",
            ));
        }
        let descriptor = inspected
            .manifest
            .capabilities
            .iter()
            .find(|c| c.capability == binding.capability)
            .ok_or_else(|| {
                Failure::invalid("The selected version does not contribute this tool")
            })?;
        let kind = match descriptor.kind {
            CapabilityKind::Query => AgentNativeToolKind::Query,
            CapabilityKind::Operation => AgentNativeToolKind::Operation,
            _ => {
                return Err(Failure::invalid(
                    "Native tools accept query and Operation capabilities only",
                ));
            }
        };
        require(
            metadata,
            call,
            &descriptor.capability,
            &descriptor.required_scopes,
        )?;
        if kind == AgentNativeToolKind::Operation {
            for cap in ["operation.get", "plugins.delegated_operation"] {
                require(
                    metadata,
                    call,
                    &manifest::key(cap),
                    &["operation.read".into()].into(),
                )?;
            }
        }
        tools.push(AgentNativeToolGrant {
            selection,
            kind,
            description: descriptor.description.clone(),
            input_schema: descriptor.input_schema.clone(),
            required_scopes: descriptor.required_scopes.clone(),
        });
    }
    // Resolving manifests awaited Host reads. Restore the live caller check at
    // the synchronous native admission boundary, including connection identity.
    let pending = host
        .begin(
            read_id(),
            call.request.clone(),
            manifest::key("views.caller"),
            json!({}),
        )
        .map_err(|_| Failure::invalid("Native tool caller revalidation is unavailable"))?;
    if server::caller(pending.receive().await)? != *caller {
        return Err(Failure::invalid(
            "The native caller changed before tool admission",
        ));
    }
    Ok(tools)
}
pub(crate) fn require(
    metadata: &Metadata,
    call: &PluginCall,
    key: &CapabilityKey,
    scopes: &BTreeSet<String>,
) -> Result<(), Failure> {
    if !scopes.is_subset(&call.scopes)
        || !metadata.grants.iter().any(|g| {
            &g.capability == key && scopes.is_subset(&g.scopes) && g.scopes.is_subset(&call.scopes)
        })
    {
        return Err(Failure {
            code: "access_denied",
            message: format!(
                "The original request lacks the selected grant for {}",
                key.id
            ),
        });
    }
    Ok(())
}
pub(crate) fn read_id() -> RequestId {
    RequestId::new(format!("agent-native-read-{}", uuid::Uuid::new_v4())).unwrap()
}
pub(crate) async fn query(
    host: &HostCallClient,
    parent: &RequestId,
    key: CapabilityKey,
    arguments: Value,
) -> Result<Value, Failure> {
    let value = observe(host, parent, key, arguments).await?;
    if value["status"] != "ready" || value["completeness"] != "complete" {
        return Err(Failure::invalid(
            "Original native observation is incomplete",
        ));
    }
    value
        .get("data")
        .cloned()
        .ok_or_else(|| Failure::invalid("Original native observation has no data"))
}

/// Recovery can retain partial evidence; admission still uses the complete-only
/// query above before capturing authority or performing any write.
pub(crate) async fn observe(
    host: &HostCallClient,
    parent: &RequestId,
    key: CapabilityKey,
    arguments: Value,
) -> Result<Value, Failure> {
    let pending = host
        .begin(read_id(), parent.clone(), key, arguments)
        .map_err(|_| Failure::invalid("Native observation could not be queued"))?;
    pending.receive().await.map_err(|_| {
        Failure::invalid("Original native observation is unavailable; no work was replayed")
    })
}
