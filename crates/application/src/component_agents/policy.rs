use super::{ComponentToolAction, invalid};
use crate::ApplicationError;
use rho_contract::*;
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
    let endpoint =
        url::Url::parse(&connection.base_url).map_err(|_| invalid("Invalid model endpoint"))?;
    let local = match endpoint.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if connection.base_url.len() > 2048
        || endpoint.host().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !(endpoint.scheme() == "https" || (endpoint.scheme() == "http" && local))
    {
        return Err(invalid(
            "Model endpoint requires HTTPS or explicit loopback HTTP without embedded credentials",
        ));
    }
    if connection.model.trim().is_empty()
        || connection.model.len() > 256
        || connection.model.chars().any(char::is_control)
    {
        return Err(invalid("Invalid model ID"));
    }
    match &connection.credential {
        ComponentCredentialRef::Environment { name }
            if !name.is_empty()
                && name.len() <= 128
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && !name.as_bytes()[0].is_ascii_digit() => {}
        ComponentCredentialRef::Session { key_id } if token(key_id) => {}
        _ => return Err(invalid("Invalid credential reference")),
    }
    Ok(())
}

pub fn validate_component_grant(
    profile: ComponentAgentProfile,
    grant: &ComponentAgentGrant,
) -> Result<(), ApplicationError> {
    use ComponentAgentMode::*;
    use ComponentAgentProfile::*;
    if matches!(profile, Objects | Packages | Plots | Environment) && grant.mode != Explain {
        return Err(invalid("This component only supports Explain"));
    }
    if grant.documents.len() > 16 || grant.files.len() > 16 {
        return Err(invalid("Too many authorized targets"));
    }
    if grant.mode == Explain && (!grant.documents.is_empty() || !grant.files.is_empty()) {
        return Err(invalid("Explain cannot grant writes"));
    }
    if grant.mode == Run && grant.session.is_none() {
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
    if grant.mode == Edit && grant.documents.is_empty() && grant.files.is_empty() {
        return Err(invalid("Edit requires an explicit document or file"));
    }
    Ok(())
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
        Documents => documents || packages,
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
        ComponentToolAction::Query(query) => {
            if query.capability.version != 1
                || !component_query_allowed(run.profile, &query.capability.id)
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
            if run.request.grant.mode != ComponentAgentMode::Run
                || !matches!(
                    run.profile,
                    ComponentAgentProfile::Workspace | ComponentAgentProfile::Project
                )
                || invocation.capability.id != "workspace.run_r"
                || invocation.capability.version != 1
            {
                return Err(denied());
            }
            let session = run.request.grant.session.as_ref().ok_or_else(denied)?;
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
            if command.window != run.request.window
                || run.request.grant.mode == ComponentAgentMode::Explain
            {
                return Err(denied());
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
            let grant = run
                .request
                .grant
                .documents
                .iter()
                .find(|g| g.document == *document)
                .ok_or_else(denied)?;
            if (save && !grant.allow_save)
                || (execute && run.request.grant.mode != ComponentAgentMode::Run)
                || target.is_some_and(|path| Some(path) != grant.path.as_deref())
            {
                return Err(denied());
            }
        }
    }
    Ok(())
}
