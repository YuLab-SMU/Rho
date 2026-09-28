//! Scientific plugin actions use the original captured provider and native target.
//! This layer validates task intent only; the real provider and Host still admit
//! scopes, preconditions and Operations. No runtime discovery or dispatch here.
use super::*;

pub(super) fn validate_targets(
    request: &ComponentAgentStart,
    origin: &ComponentNativeRunOrigin,
) -> Result<(), ApplicationError> {
    if request.continuation.is_some()
        || request.grant.permission_policy.is_some()
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
        (None, None) if request.grant.mode == ComponentAgentMode::Explain => Ok(()),
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
    let r = origin.r.as_ref().ok_or_else(denied)?;
    let (request, mutation) = match action {
        ComponentToolAction::PluginQuery(request) => (request, false),
        ComponentToolAction::PluginInvoke(request) => (request, true),
        _ => return Err(denied()),
    };
    let b = &request.binding;
    if b.provider != r.provider
        || b.project != r.project
        || b.target != r.target
        || !request.preconditions.is_null()
    {
        return Err(denied());
    }
    if !mutation {
        if b.capability.id.as_str() != "r.session"
            || b.capability.version != 1
            || request.arguments != serde_json::json!({})
        {
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
