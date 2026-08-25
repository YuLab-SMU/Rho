use super::*;

pub(super) fn record_call_event(
    store: &mut Store,
    context: &PluginRuntimeContext,
    plugin_id: &str,
    package_digest: &str,
    grant_id: Option<&str>,
    event_type: &str,
    status: &str,
    reason_code: Option<&str>,
    details: serde_json::Value,
    consume_allow_once: bool,
) -> Result<String> {
    PluginPermissionMutationService::new(store)
        .record_call_event(
            &context.project_root,
            &PluginPermissionCallEventDraft {
                project_root: context.project_root.clone(),
                plugin_id: plugin_id.to_string(),
                package_digest: package_digest.to_string(),
                grant_id: grant_id.map(str::to_string),
                event_type: event_type.to_string(),
                status: status.to_string(),
                reason_code: reason_code.map(str::to_string),
                details_json: details.to_string(),
            },
            consume_allow_once,
        )
        .map_err(Into::into)
}

pub(super) fn grant_error_code(error: GrantErrorKind) -> &'static str {
    match error {
        GrantErrorKind::UnknownHandle => "unknown_handle",
        GrantErrorKind::Revoked => "grant_revoked",
        GrantErrorKind::Expired => "grant_expired",
        GrantErrorKind::Consumed => "grant_consumed",
        GrantErrorKind::InFlight => "grant_in_flight",
        GrantErrorKind::NotAdmitted => "grant_not_admitted",
        GrantErrorKind::WrongPlugin => "wrong_plugin",
        GrantErrorKind::WrongHostSession => "wrong_host_session",
        GrantErrorKind::WrongProject => "wrong_project",
        GrantErrorKind::WrongScope => "wrong_scope",
        GrantErrorKind::WrongGeneration => "wrong_generation",
        GrantErrorKind::WrongPackageDigest => "wrong_package_digest",
        GrantErrorKind::WrongPermission => "wrong_permission",
        GrantErrorKind::WrongWorkspace => "wrong_workspace",
        GrantErrorKind::ConstraintViolation => "constraint_violation",
    }
}

pub(super) fn project_file_error_code(error: ProjectFsReadErrorCode) -> &'static str {
    match error {
        ProjectFsReadErrorCode::InvalidProject => "invalid_project",
        ProjectFsReadErrorCode::InvalidPath => "invalid_path",
        ProjectFsReadErrorCode::ReservedPath => "reserved_path",
        ProjectFsReadErrorCode::StaleProject => "stale_project",
        ProjectFsReadErrorCode::SymlinkOrReparse => "symlink_or_reparse",
        ProjectFsReadErrorCode::NestedRepository => "nested_repository",
        ProjectFsReadErrorCode::NotRegularFile => "not_regular_file",
        ProjectFsReadErrorCode::OutsideProject => "outside_project",
        ProjectFsReadErrorCode::TooLarge => "too_large",
        ProjectFsReadErrorCode::FileChanged => "file_changed",
        ProjectFsReadErrorCode::IoFailed => "io_failed",
    }
}

pub(super) fn workspace_error_code(error: WorkspaceInspectErrorCode) -> &'static str {
    match error {
        WorkspaceInspectErrorCode::InvalidProject => "invalid_project",
        WorkspaceInspectErrorCode::InvalidSnapshot => "invalid_snapshot",
        WorkspaceInspectErrorCode::ReferenceLimit => "reference_limit",
        WorkspaceInspectErrorCode::UnknownReference => "unknown_object_reference",
        WorkspaceInspectErrorCode::StaleWorkspace => "stale_workspace",
        WorkspaceInspectErrorCode::ObjectChanged => "object_changed",
        WorkspaceInspectErrorCode::MalformedResult => "malformed_workspace_result",
        WorkspaceInspectErrorCode::ResultTooLarge => "workspace_result_too_large",
    }
}

pub(super) fn network_error_code(error: NetworkFetchErrorCode) -> &'static str {
    match error {
        NetworkFetchErrorCode::InvalidUrl => "invalid_url",
        NetworkFetchErrorCode::HostNotAllowed => "host_not_allowed",
        NetworkFetchErrorCode::MethodNotAllowed => "method_not_allowed",
        NetworkFetchErrorCode::StaleProject => "stale_project",
        NetworkFetchErrorCode::DnsFailed => "dns_failed",
        NetworkFetchErrorCode::NonPublicAddress => "non_public_address",
        NetworkFetchErrorCode::AuthorizationDenied => "authorization_denied",
        NetworkFetchErrorCode::RedirectMissingLocation => "redirect_missing_location",
        NetworkFetchErrorCode::TooManyRedirects => "too_many_redirects",
        NetworkFetchErrorCode::ResponseTooLarge => "response_too_large",
        NetworkFetchErrorCode::Timeout => "network_timeout",
        NetworkFetchErrorCode::TransportFailed => "transport_failed",
    }
}

pub(super) fn workspace_inspection_context(
    context: &PluginRuntimeContext,
) -> Result<WorkspaceInspectionContext> {
    let workspace = context
        .workspace
        .as_ref()
        .context("Workspace R identity is unavailable for plugin inspection")?;
    Ok(WorkspaceInspectionContext {
        project_root: context.project_root.clone(),
        workspace: rho_protocol::WorkspaceIdentity {
            workspace_id: workspace.workspace_id.clone(),
            kernel_instance_id: workspace.kernel_instance_id.clone(),
            execution_seq: 0,
            state_revision: workspace.state_revision,
            project_revision: workspace.project_revision,
        },
    })
}

pub(super) fn same_workspace_grant_identity(
    expected: Option<&WorkspaceGrantIdentity>,
    actual: &rho_protocol::WorkspaceIdentity,
) -> bool {
    expected.is_some_and(|expected| {
        expected.workspace_id == actual.workspace_id
            && expected.kernel_instance_id == actual.kernel_instance_id
            && expected.state_revision == actual.state_revision
            && expected.project_revision == actual.project_revision
    })
}
