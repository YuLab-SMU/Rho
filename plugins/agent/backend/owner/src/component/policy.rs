use super::ComponentTaskError as ApplicationError;
use super::{ComponentToolAction, invalid};
use rho_agent_api::component::*;
use rho_agent_api::*;
use std::collections::BTreeSet;

fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b))
}
fn path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.starts_with('/')
        && !value.contains(['\\', ':'])
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
pub fn validate_component_model(
    connection: &ComponentModelConnection,
) -> Result<(), ApplicationError> {
    crate::validate_model_connection(connection).map_err(Into::into)
}

pub fn validate_component_grant(
    profile: ComponentAgentProfile,
    grant: &ComponentAgentGrant,
) -> Result<(), ApplicationError> {
    validate_grant(profile, grant, false)
}
pub(super) fn validate_native_grant(
    profile: ComponentAgentProfile,
    grant: &ComponentAgentGrant,
    origin: &super::ComponentNativeRunOrigin,
) -> Result<(), ApplicationError> {
    validate_grant(
        profile,
        grant,
        origin
            .tools
            .iter()
            .any(|tool| tool.kind == AgentNativeToolKind::Operation),
    )
}
fn validate_grant(
    profile: ComponentAgentProfile,
    grant: &ComponentAgentGrant,
    workspace_operations: bool,
) -> Result<(), ApplicationError> {
    use ComponentAgentMode::*;
    use ComponentAgentProfile::*;
    if grant.permission_policy.is_none()
        && matches!(profile, Objects | Packages | Plots | Environment)
        && grant.mode != Explain
    {
        return Err(invalid("This component only supports Explain"));
    }
    if grant.documents.len() > 16 || grant.files.len() > 16 {
        return Err(invalid("Too many authorized targets"));
    }
    if grant.permission_policy.is_none()
        && grant.mode == Explain
        && (!grant.documents.is_empty() || !grant.files.is_empty())
    {
        return Err(invalid("Explain cannot grant writes"));
    }
    if grant.permission_policy.is_none()
        && grant.mode == Run
        && grant.session.is_none()
        && !workspace_operations
    {
        return Err(invalid("Run requires an explicit native R session"));
    }
    if let Some(session) = &grant.session
        && (!token(&session.workspace_instance_id) || !token(&session.session_id))
    {
        return Err(invalid("Invalid R session binding"));
    }
    let mut documents = BTreeSet::new();
    for target in &grant.documents {
        if !token(&target.document.document_id)
            || !token(&target.document.document_version)
            || !token(&target.document.selection_version)
            || !documents.insert(&target.document.document_id)
            || target.path.as_deref().is_some_and(|s| !path(s))
            || (target.allow_save && target.path.is_none())
        {
            return Err(invalid("Invalid or duplicate document grant"));
        }
    }
    let mut files = BTreeSet::new();
    for target in &grant.files {
        if !path(&target.path)
            || !files.insert(&target.path)
            || target.sha256.len() != 64
            || !target.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid("Invalid or duplicate file grant"));
        }
    }
    if grant.permission_policy.is_none()
        && grant.mode == Edit
        && grant.documents.is_empty()
        && grant.files.is_empty()
    {
        return Err(invalid("Edit requires an explicit document or file"));
    }
    Ok(())
}

pub fn component_query_available(run: &ComponentAgentRun, capability: &str) -> bool {
    if run.request.grant.permission_policy.is_none() {
        return component_query_allowed(run.profile, capability);
    }
    [
        ComponentAgentProfile::Project,
        ComponentAgentProfile::Environment,
    ]
    .into_iter()
    .any(|profile| component_query_allowed(profile, capability))
}

/// Profiles reference real registry IDs; capabilities not listed here stay unavailable.
pub fn component_query_allowed(profile: ComponentAgentProfile, capability: &str) -> bool {
    use ComponentAgentProfile::*;
    if matches!(
        capability,
        "host.describe"
            | "host.resolve_context"
            | "host.overview"
            | "skill.list"
            | "skill.read"
            | "operation.get"
            | "operation.read_evidence"
    ) {
        return true;
    }
    let objects = matches!(
        capability,
        "workspace.list_objects" | "workspace.observe_object" | "workspace.read_object"
    );
    let packages = matches!(
        capability,
        "workspace.packages" | "workspace.package_index" | "workspace.read_help"
    );
    let plots = matches!(
        capability,
        "workspace.list_outputs" | "workspace.read_output" | "output.view"
    );
    let documents = matches!(
        capability,
        "application.read_document" | "application.context"
    );
    let runtime = matches!(
        capability,
        "workspace.runtime_status" | "workspace.console_state"
    );
    match profile {
        Objects => objects,
        Packages => packages,
        Plots => plots,
        Documents => documents || packages || runtime,
        Workspace => runtime || objects || packages || plots || documents,
        Project => {
            runtime
                || objects
                || packages
                || plots
                || documents
                || matches!(
                    capability,
                    "project.list_directory"
                        | "project.read_text"
                        | "project.search_text"
                        | "project.search_files"
                        | "project.snapshot"
                )
        }
        Environment => {
            matches!(
                capability,
                "environment.observe"
                    | "runtime.instances"
                    | "runtime.instance"
                    | "runtime.settings"
                    | "workspace.checkpoints"
            ) || runtime
                || packages
        }
    }
}

pub(super) fn authorize_tool(
    run: &ComponentAgentRun,
    action: &ComponentToolAction,
) -> Result<(), ApplicationError> {
    let denied = || invalid("Tool action exceeds the component request's authorization");
    match action {
        // Plugin actions require a stored native origin and the separate exact-binding validator.
        ComponentToolAction::PluginQuery(_) | ComponentToolAction::PluginInvoke(_) => {
            return Err(denied());
        }
        ComponentToolAction::TaskIntent(intent) => {
            validate_task_intent(run, intent)?;
        }
        ComponentToolAction::PreviousResult { .. } => return Err(denied()),
        ComponentToolAction::Rejected {
            capability,
            arguments_digest,
            feedback,
        } => {
            if CapabilityRef::new(capability.id.clone(), capability.version).is_err()
                || feedback["status"] != "rejected"
                || feedback["accepted"] != false
                || arguments_digest.len() != 64
                || !arguments_digest.bytes().all(|b| b.is_ascii_hexdigit())
                || serde_json::to_vec(feedback).map_err(super::storage)?.len() > 16 * 1024
            {
                return Err(denied());
            }
        }
        ComponentToolAction::Query(query) => {
            if query.capability.version != 1
                || !component_query_available(run, &query.capability.id)
            {
                return Err(denied());
            }
            if let Some(window) = query.arguments.get("window")
                && window != &serde_json::to_value(&run.request.window).map_err(super::storage)?
            {
                return Err(denied());
            }
            if let Some(instance) = query.arguments.get("workspace_instance_id")
                && run
                    .request
                    .grant
                    .session
                    .as_ref()
                    .is_none_or(|session| instance.as_str() != Some(&session.workspace_instance_id))
            {
                return Err(denied());
            }
            if let Some(expected) = query.arguments.get("expected_session")
                && !expected.is_null()
                && run
                    .request
                    .grant
                    .session
                    .as_ref()
                    .is_none_or(|session| expected.as_str() != Some(&session.session_id))
            {
                return Err(denied());
            }
        }
        ComponentToolAction::Invoke(invocation) => {
            invocation.validate().map_err(|_| denied())?;
            let resume = invocation.capability.id == "workspace.resume_queue";
            if !run.request.grant.allows_execution()
                || invocation.capability.version != 1
                || (!resume
                    && (invocation.capability.id != "workspace.run_r"
                        || (run.request.grant.permission_policy.is_none()
                            && !matches!(
                                run.profile,
                                ComponentAgentProfile::Workspace | ComponentAgentProfile::Project
                            ))))
                || (resume
                    && run.request.grant.permission_policy.is_none()
                    && !matches!(
                        run.profile,
                        ComponentAgentProfile::Workspace
                            | ComponentAgentProfile::Project
                            | ComponentAgentProfile::Documents
                    ))
            {
                return Err(denied());
            }
            let session = run.request.grant.session.as_ref().ok_or_else(denied)?;
            if resume
                && (invocation.arguments["session_id"].as_str() != Some(&session.session_id)
                    || invocation.arguments["pause_id"].as_str().is_none()
                    || invocation.arguments["only_operation_ids"]
                        .as_array()
                        .is_none_or(|ids| ids.is_empty() || ids.len() > 32))
            {
                return Err(denied());
            }
            if invocation
                .arguments
                .get("workspace_instance_id")
                .and_then(|v| v.as_str())
                != Some(&session.workspace_instance_id)
                || !invocation.preconditions.iter().any(|p| {
                    p.kind == "workspace.session"
                        && p.subject == "active"
                        && p.expected.as_str() == Some(&session.session_id)
                })
            {
                return Err(denied());
            }
        }
        ComponentToolAction::Control(command) => {
            if command.window != run.request.window || !run.request.grant.allows_edit() {
                return Err(denied());
            }
            if run.request.grant.permission_policy.is_some() {
                match &command.action {
                    ApplicationAction::OpenDocument { path: target, .. } if path(target) => {
                        return Ok(());
                    }
                    ApplicationAction::CreateDocument {
                        path: Some(target),
                        text,
                        ..
                    } if path(target) && text.is_empty() => return Ok(()),
                    _ => {}
                }
            }
            let (document, save, execute, target) = match &command.action {
                ApplicationAction::EditDocument { document, .. } => (document, false, false, None),
                ApplicationAction::Save {
                    document,
                    target_path,
                } => (document, true, false, target_path.as_deref()),
                ApplicationAction::RunFile {
                    document,
                    target_path,
                } => (document, true, true, target_path.as_deref()),
                ApplicationAction::RunSelection { document } => (document, false, true, None),
                _ => return Err(denied()),
            };
            let grant =
                super::component_document_grant(run, &document.document_id).ok_or_else(denied)?;
            if super::component_document_reference(run, &document.document_id) != Some(document) {
                return Err(denied());
            }
            if (save && !run.request.grant.allows_save(grant))
                || (execute && !run.request.grant.allows_execution())
                || target.is_some_and(|path| Some(path) != grant.path.as_deref())
            {
                return Err(denied());
            }
            if execute {
                let session = run.request.grant.session.as_ref().ok_or_else(denied)?;
                if command.execution_target.as_ref()
                    != Some(&ApplicationExecutionTarget {
                        workspace_instance_id: session.workspace_instance_id.clone(),
                        native_session_id: session.session_id.clone(),
                    })
                {
                    return Err(denied());
                }
            }
        }
    }
    Ok(())
}

pub(super) fn validate_task_intent(
    run: &ComponentAgentRun,
    intent: &ComponentAgentTaskIntent,
) -> Result<(), ApplicationError> {
    if run.request.grant.permission_policy.is_none()
        || intent.request_id != run.request.request_id
        || intent.request_excerpt.trim().is_empty()
        || !run.request.text.contains(&intent.request_excerpt)
        || intent.actions.len() > 48
        || serde_json::to_vec(intent).map_or(true, |bytes| bytes.len() > 64 * 1024)
        || run
            .task_intent
            .as_ref()
            .is_some_and(|saved| saved != intent)
    {
        return Err(invalid(
            "Task intent must quote this user's request and cannot change once recorded",
        ));
    }
    let mut targets = BTreeSet::new();
    for action in &intent.actions {
        if action.action == ComponentRequestedAction::Execute && run.request.grant.session.is_none()
        {
            return Err(invalid(
                "Task execution requires the original R session binding",
            ));
        }
        match (&action.document_id, &action.path) {
            (Some(id), None) if super::component_document_grant(run, id).is_some() => {}
            (None, Some(target)) if path(target) => {}
            (None, None) if action.action == ComponentRequestedAction::Execute => {}
            _ => {
                return Err(invalid(
                    "Task intent target is outside this request's documents",
                ));
            }
        }
        if action.document_id.is_some() || action.path.is_some() {
            targets.insert((&action.document_id, &action.path));
        }
    }
    if targets.len() > 16 {
        return Err(invalid("Task intent exceeds the document target limit"));
    }
    Ok(())
}
