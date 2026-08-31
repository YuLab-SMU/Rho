use std::collections::BTreeMap;

use rho_ui_contract::{
    ContractError, Validate, WorkbenchCommandEnvelopeV1, WorkbenchCommandResponseV1,
    WorkbenchHotCursorV1, WorkbenchReconnectResponseV1,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_CALLER_ID_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct AuthenticatedWorkbenchCaller {
    pub(crate) caller_id: String,
    pub(crate) project_session_id: String,
    pub(crate) owns_session: bool,
}

pub(crate) trait WorkbenchControlPlanePort {
    fn dispatch(
        &mut self,
        caller: &AuthenticatedWorkbenchCaller,
        command: WorkbenchCommandEnvelopeV1,
    ) -> WorkbenchCommandResponseV1;

    fn reconnect(
        &mut self,
        caller: &AuthenticatedWorkbenchCaller,
        after: WorkbenchHotCursorV1,
    ) -> WorkbenchReconnectResponseV1;

    fn unsubscribe(&mut self, caller: &AuthenticatedWorkbenchCaller, subscription_id: &str);
}

#[derive(Debug, Error)]
pub(crate) enum WorkbenchTransportError {
    #[error("caller identity is invalid")]
    InvalidCaller,
    #[error("caller does not own project session")]
    SessionOwnership,
    #[error("command contract rejected: {0}")]
    Contract(#[from] ContractError),
    #[error("response contract rejected: {0}")]
    ResponseContract(ContractError),
}

pub(crate) fn handle_agent_contract_command(
    caller: &AuthenticatedWorkbenchCaller,
    command: WorkbenchCommandEnvelopeV1,
    port: &mut impl WorkbenchControlPlanePort,
) -> Result<WorkbenchCommandResponseV1, WorkbenchTransportError> {
    authenticate(caller)?;
    command.validate()?;
    let response = port.dispatch(caller, command);
    response
        .validate()
        .map_err(WorkbenchTransportError::ResponseContract)?;
    Ok(response)
}

pub(crate) fn handle_agent_contract_reconnect(
    caller: &AuthenticatedWorkbenchCaller,
    after: WorkbenchHotCursorV1,
    port: &mut impl WorkbenchControlPlanePort,
) -> Result<WorkbenchReconnectResponseV1, WorkbenchTransportError> {
    authenticate(caller)?;
    let response = port.reconnect(caller, after);
    response
        .validate()
        .map_err(WorkbenchTransportError::ResponseContract)?;
    Ok(response)
}

pub(crate) fn handle_agent_contract_unsubscribe(
    caller: &AuthenticatedWorkbenchCaller,
    subscription_id: &str,
    port: &mut impl WorkbenchControlPlanePort,
) -> Result<(), WorkbenchTransportError> {
    authenticate(caller)?;
    if subscription_id.is_empty() || subscription_id.len() > MAX_CALLER_ID_BYTES {
        return Err(WorkbenchTransportError::InvalidCaller);
    }
    port.unsubscribe(caller, subscription_id);
    Ok(())
}

fn authenticate(caller: &AuthenticatedWorkbenchCaller) -> Result<(), WorkbenchTransportError> {
    if caller.caller_id.is_empty()
        || caller.project_session_id.is_empty()
        || caller.caller_id.len() > MAX_CALLER_ID_BYTES
        || caller.project_session_id.len() > MAX_CALLER_ID_BYTES
    {
        return Err(WorkbenchTransportError::InvalidCaller);
    }
    if !caller.owns_session {
        return Err(WorkbenchTransportError::SessionOwnership);
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct DesktopWorkbenchPort {
    responses: BTreeMap<String, WorkbenchCommandResponseV1>,
}

impl WorkbenchControlPlanePort for DesktopWorkbenchPort {
    fn dispatch(
        &mut self,
        _caller: &AuthenticatedWorkbenchCaller,
        command: WorkbenchCommandEnvelopeV1,
    ) -> WorkbenchCommandResponseV1 {
        let identity = command_identity(&command);
        if let Some(response) = self.responses.get(&identity) {
            return response.clone();
        }
        let response = WorkbenchCommandResponseV1::Accepted {
            operation_id: format!("operation_{identity}"),
            accepted_at_revision: 0,
        };
        self.responses.insert(identity, response.clone());
        response
    }

    fn reconnect(
        &mut self,
        _caller: &AuthenticatedWorkbenchCaller,
        _after: WorkbenchHotCursorV1,
    ) -> WorkbenchReconnectResponseV1 {
        rho_ui_contract::workbench_vnext_fixture()
    }

    fn unsubscribe(&mut self, _caller: &AuthenticatedWorkbenchCaller, _subscription_id: &str) {}
}

fn command_identity(command: &WorkbenchCommandEnvelopeV1) -> String {
    use rho_ui_contract::WorkbenchCommandV1;
    match &command.command {
        WorkbenchCommandV1::SubmitGoal { goal_id, .. } => goal_id.clone(),
        WorkbenchCommandV1::ApprovalDecision { approval_id, .. } => approval_id.clone(),
        WorkbenchCommandV1::Cancel { activity_id } => activity_id.clone(),
        WorkbenchCommandV1::ConfigureProvider {
            provider_config_id, ..
        } => provider_config_id.clone(),
        WorkbenchCommandV1::OpenArtifact { artifact_id, .. } => artifact_id.clone(),
        WorkbenchCommandV1::QueryJob { job_id, .. } => job_id.clone(),
    }
}

// Contract harness only. Production does not register this fixture-backed path;
// the autonomous Agent surface uses the authenticated UiKernel transport.
pub(crate) fn workbench_provider_capabilities() -> rho_ui_contract::NegotiatedProviderCapabilitiesV1
{
    rho_ui_contract::first_party_provider_capabilities_fixture()
}

pub(crate) fn workbench_vnext_command(
    caller: AuthenticatedWorkbenchCaller,
    command: WorkbenchCommandEnvelopeV1,
    state: tauri::State<'_, crate::application_state::ApplicationState>,
) -> Result<WorkbenchCommandResponseV1, String> {
    let mut port = state
        .workbench
        .lock()
        .map_err(|_| "workbench state poisoned".to_string())?;
    handle_agent_contract_command(&caller, command, &mut *port).map_err(|error| error.to_string())
}

pub(crate) fn workbench_vnext_reconnect(
    caller: AuthenticatedWorkbenchCaller,
    after: WorkbenchHotCursorV1,
    state: tauri::State<'_, crate::application_state::ApplicationState>,
) -> Result<WorkbenchReconnectResponseV1, String> {
    let mut port = state
        .workbench
        .lock()
        .map_err(|_| "workbench state poisoned".to_string())?;
    handle_agent_contract_reconnect(&caller, after, &mut *port).map_err(|error| error.to_string())
}

pub(crate) fn workbench_vnext_unsubscribe(
    caller: AuthenticatedWorkbenchCaller,
    subscription_id: String,
    state: tauri::State<'_, crate::application_state::ApplicationState>,
) -> Result<(), String> {
    let mut port = state
        .workbench
        .lock()
        .map_err(|_| "workbench state poisoned".to_string())?;
    handle_agent_contract_unsubscribe(&caller, &subscription_id, &mut *port)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use rho_ui_contract::{
        WorkbenchCommandResponseV1, WorkbenchGapV1, WorkbenchHotCursorV1,
        workbench_command_fixtures, workbench_vnext_fixture,
    };

    use super::*;

    #[derive(Default)]
    struct FakeControlPlane {
        dispatch_count: usize,
        unsubscribe_count: usize,
    }

    impl WorkbenchControlPlanePort for FakeControlPlane {
        fn dispatch(
            &mut self,
            _caller: &AuthenticatedWorkbenchCaller,
            _command: WorkbenchCommandEnvelopeV1,
        ) -> WorkbenchCommandResponseV1 {
            self.dispatch_count += 1;
            WorkbenchCommandResponseV1::Committed {
                operation_id: "operation_transport".to_string(),
                event_id: "event_transport".to_string(),
                snapshot_revision: 45,
            }
        }

        fn reconnect(
            &mut self,
            _caller: &AuthenticatedWorkbenchCaller,
            after: WorkbenchHotCursorV1,
        ) -> WorkbenchReconnectResponseV1 {
            let mut fixture = workbench_vnext_fixture();
            if after.cursor < 50 {
                fixture.gap = Some(WorkbenchGapV1 {
                    requested_after: after,
                    oldest_available: WorkbenchHotCursorV1 { cursor: 50 },
                    latest: fixture.hot_cursor.clone(),
                });
            }
            fixture
        }

        fn unsubscribe(&mut self, _caller: &AuthenticatedWorkbenchCaller, _subscription_id: &str) {
            self.unsubscribe_count += 1;
        }
    }

    fn caller() -> AuthenticatedWorkbenchCaller {
        AuthenticatedWorkbenchCaller {
            caller_id: "renderer_main".to_string(),
            project_session_id: "project_session_main".to_string(),
            owns_session: true,
        }
    }

    #[test]
    fn provider_capability_command_uses_neutral_validated_fixture() {
        let capabilities = workbench_provider_capabilities();
        capabilities.validate().unwrap();
        assert!(
            capabilities
                .features
                .contains(&rho_ui_contract::ProviderFeatureV1::Config)
        );
    }

    #[test]
    fn agent_contract_transport_parses_authenticates_and_delegates_without_policy_copy() {
        let mut port = FakeControlPlane::default();
        let response = handle_agent_contract_command(
            &caller(),
            workbench_command_fixtures().remove(0),
            &mut port,
        )
        .unwrap();
        assert!(matches!(
            response,
            WorkbenchCommandResponseV1::Committed { .. }
        ));
        assert_eq!(port.dispatch_count, 1);

        let mut unowned = caller();
        unowned.owns_session = false;
        assert!(matches!(
            handle_agent_contract_command(
                &unowned,
                workbench_command_fixtures().remove(0),
                &mut port,
            ),
            Err(WorkbenchTransportError::SessionOwnership)
        ));
        assert_eq!(port.dispatch_count, 1);
    }

    #[test]
    fn agent_contract_reconnect_returns_snapshot_cursor_gap_without_token_history() {
        let mut port = FakeControlPlane::default();
        let response = handle_agent_contract_reconnect(
            &caller(),
            WorkbenchHotCursorV1 { cursor: 10 },
            &mut port,
        )
        .unwrap();
        assert!(response.gap.is_some());
        assert!(!response.replayed_token_history);
        handle_agent_contract_unsubscribe(&caller(), "subscription_main", &mut port).unwrap();
        assert_eq!(port.unsubscribe_count, 1);
    }

    #[test]
    fn agent_contract_command_source_has_no_policy_or_provider_state_machine() {
        let source = include_str!("workbench_vnext.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in [
            "BrokerDecisionKind",
            "ProviderRuntimeEvent",
            "Aisdk",
            "Acp",
            "SemanticStore",
        ] {
            assert!(!source.contains(forbidden));
        }
    }
}
