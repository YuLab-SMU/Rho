//! Scientific plugin actions use the original captured provider and native target.
//! This layer validates task intent only; the real provider and Host still admit
//! scopes, preconditions and Operations. No runtime discovery or dispatch here.
use super::*;

pub(super) fn validate_targets(
    request: &ComponentAgentStart,
    origin: &ComponentNativeRunOrigin,
) -> Result<(), ApplicationError> {
    if request.grant.permission_policy.is_some()
        || !request.grant.documents.is_empty()
        || !request.grant.files.is_empty()
        || !matches!(
            request.grant.mode,
            ComponentAgentMode::Explain | ComponentAgentMode::Run
        )
    {
        return Err(invalid("Unsupported native model task authorization"));
    }
    match (&origin.r, &request.grant.session) {
        (None, None)
            if request.grant.mode == ComponentAgentMode::Explain || !origin.tools.is_empty() =>
        {
            Ok(())
        }
        (Some(binding), Some(session))
            if binding.provider.instance.as_str() == session.workspace_instance_id
                && binding.target.as_deref() == Some(session.session_id.as_str())
                && (request.grant.mode == ComponentAgentMode::Explain
                    || (binding.capability.id.as_str() == "r.execute"
                        && binding.capability.version == 2)) =>
        {
            Ok(())
        }
        _ => Err(invalid(
            "Task R target differs from its original native capture",
        )),
    }
}

pub(super) fn authorize(
    run: &StoredComponentRun,
    action: &ComponentToolAction,
) -> Result<(), ApplicationError> {
    let denied = || invalid("Plugin tool exceeds the task's captured native authorization");
    let origin = run.native_origin.as_ref().ok_or_else(denied)?;
    origin.validate()?;
    validate_targets(&run.run.request, origin)?;

    let (request, mutation) = match action {
        ComponentToolAction::PluginQuery(request) => (request, false),
        ComponentToolAction::PluginInvoke(request) => (request, true),
        _ => return Err(denied()),
    };
    let b = &request.binding;
    if let Some(tool) = origin.tools.iter().find(|tool| {
        matches!(&tool.selection.target,
        AgentNativeToolTarget::Provider { binding } if binding == b)
    }) {
        if mutation != (tool.kind == AgentNativeToolKind::Operation)
            || mutation && run.run.request.grant.mode != ComponentAgentMode::Run
        {
            return Err(denied());
        }
        if b.capability.id.as_str().starts_with("editor.") {
            let window = &run.run.request.window.window_id;
            let observed = if matches!(
                b.capability.id.as_str(),
                "editor.context.search" | "editor.run.inspect"
            ) {
                &request.arguments["window"]
            } else {
                &request.arguments["reference"]["window"]
            };
            if observed != &serde_json::json!(window) {
                return Err(denied());
            }
            if b.capability.id.as_str() == "editor.run" {
                let r = origin.r.as_ref().ok_or_else(denied)?;
                if request.arguments["runtime"] != serde_json::json!(r.provider)
                    || request.arguments["expected_session"].as_str() != r.target.as_deref()
                {
                    return Err(denied());
                }
            }
        }
        return Ok(());
    }
    let r = origin.r.as_ref().ok_or_else(denied)?;
    if b.provider != r.provider
        || b.project != r.project
        || b.target != r.target
        || !request.preconditions.is_null()
    {
        return Err(denied());
    }
    if !mutation {
        let permitted = match b.capability.id.as_str() {
            "r.session" => request.arguments == serde_json::json!({}),
            "r.list_objects" | "r.observe_object" | "r.read_object" => {
                request.arguments["expected_session"].as_str() == r.target.as_deref()
            }
            _ => false,
        };
        if b.capability.version != 1 || !permitted {
            return Err(denied());
        }
    } else {
        if run.run.request.grant.mode != ComponentAgentMode::Run || b != r {
            return Err(denied());
        }
        let input: ExecuteR =
            serde_json::from_value(request.arguments.clone()).map_err(|_| denied())?;
        // Source labels are not document provenance. This task action currently
        // accepts model-authored code only, never a forged document capture.
        if Some(input.expected_session.as_str()) != r.target.as_deref()
            || input.run.code.trim().is_empty()
            || input.run.code.len() > MAX_COMPONENT_TEXT_BYTES
            || input.run.source.is_some()
        {
            return Err(denied());
        }
    }
    Ok(())
}

/// This catalog is captured by the adapter; it cannot introduce another project,
/// the Agent itself, R execution outside the pinned session, or duplicate tools.
pub(super) fn validate_catalog(origin: &ComponentNativeRunOrigin) -> Result<(), ApplicationError> {
    let mut names = std::collections::BTreeSet::new();
    if origin.tools.len() > crate::MAX_NATIVE_TOOLS
        || serde_json::to_vec(&origin.tools)
            .map_err(|_| invalid("Invalid workspace tools"))?
            .len()
            > 65536
    {
        return Err(invalid("Workspace tool catalog exceeds its bound"));
    }
    for tool in &origin.tools {
        let AgentNativeToolTarget::Provider { binding } = &tool.selection.target else {
            return Err(invalid("Model workspace tools require an exact provider"));
        };
        if binding.project != origin.binding.project
            || binding.provider == origin.binding.provider
            || binding.capability.id.as_str().starts_with("r.")
            || !matches!(
                binding.capability.id.as_str().split('.').next(),
                Some("files" | "editor" | "environment" | "annotations")
            )
            || tool.selection.name.is_empty()
            || tool.selection.name.len() > 64
            || !tool
                .selection
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || tool.selection.name.starts_with("r_")
            || !names.insert(&tool.selection.name)
            || !tool.input_schema.is_object()
            || tool.description.len() > 4096
        {
            return Err(invalid("Invalid captured workspace tool"));
        }
    }
    Ok(())
}
