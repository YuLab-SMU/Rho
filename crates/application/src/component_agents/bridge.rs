//! No storage or policy here: preserve the one native repository transaction.
use super::*;
use serde::de::DeserializeOwned;

pub(crate) fn wire<T: Serialize + ?Sized, U: DeserializeOwned>(
    value: &T,
) -> Result<U, ApplicationError> {
    serde_json::to_vec(value)
        .and_then(|bytes| serde_json::from_slice(&bytes))
        .map_err(|_| ApplicationError::Storage("Agent record conversion failed".into()))
}
pub(crate) fn public_scope(scope: &ApplicationScope) -> rho_agent_owner::AgentTaskScope {
    rho_agent_owner::AgentTaskScope {
        project: scope.project.clone(),
        principal: scope.principal.clone(),
    }
}
pub(crate) fn native_scope(scope: &rho_agent_owner::AgentTaskScope) -> ApplicationScope {
    ApplicationScope {
        project: scope.project.clone(),
        principal: scope.principal.clone(),
    }
}
pub(super) struct RepositoryAdapter(pub Arc<dyn ComponentAgentRepository>);
impl public::ComponentAgentRepository for RepositoryAdapter {
    fn component_assets(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        conversation: &str,
    ) -> Result<Vec<AgentAsset>, public::ComponentTaskError> {
        wire(
            &self
                .0
                .component_assets(&native_scope(scope), conversation)?,
        )
        .map_err(Into::into)
    }
    fn component_asset(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        conversation: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), public::ComponentTaskError> {
        wire(
            &self
                .0
                .component_asset(&native_scope(scope), conversation, asset)?,
        )
        .map_err(Into::into)
    }
    fn put_component_asset(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        conversation: &str,
        asset: &AgentAsset,
        bytes: &[u8],
    ) -> Result<(), public::ComponentTaskError> {
        wire(
            &self
                .0
                .put_component_asset(&native_scope(scope), conversation, asset, bytes)?,
        )
        .map_err(Into::into)
    }
    fn component_diagnostic(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        request_id: &str,
    ) -> Result<
        Option<rho_agent_api::component::ComponentModelDiagnostic>,
        public::ComponentTaskError,
    > {
        wire(
            &self
                .0
                .component_diagnostic(&native_scope(scope), request_id)?,
        )
        .map_err(Into::into)
    }
    fn component_diagnostics(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
    ) -> Result<Vec<rho_agent_api::component::ComponentModelDiagnostic>, public::ComponentTaskError>
    {
        wire(&self.0.component_diagnostics(&native_scope(scope))?).map_err(Into::into)
    }
    fn write_component_diagnostic(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        expected: Option<u64>,
        diagnostic: &rho_agent_api::component::ComponentModelDiagnostic,
    ) -> Result<(), public::ComponentTaskError> {
        wire(&self.0.write_component_diagnostic(
            &native_scope(scope),
            expected,
            &wire(diagnostic)?,
        )?)
        .map_err(Into::into)
    }
    fn component_conversation(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        id: &str,
    ) -> Result<
        Option<rho_agent_api::component::ComponentAgentConversation>,
        public::ComponentTaskError,
    > {
        wire(&self.0.component_conversation(&native_scope(scope), id)?).map_err(Into::into)
    }
    fn component_conversations(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<rho_agent_api::component::ComponentAgentConversation>, public::ComponentTaskError>
    {
        wire(
            &self
                .0
                .component_conversations(&native_scope(scope), after, limit)?,
        )
        .map_err(Into::into)
    }
    fn component_run(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        id: &str,
    ) -> Result<Option<public::StoredComponentRun>, public::ComponentTaskError> {
        wire(&self.0.component_run(&native_scope(scope), id)?).map_err(Into::into)
    }
    fn component_run_by_request(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        id: &str,
    ) -> Result<Option<public::StoredComponentRun>, public::ComponentTaskError> {
        wire(&self.0.component_run_by_request(&native_scope(scope), id)?).map_err(Into::into)
    }
    fn component_run_history(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        conversation: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<
        Vec<(rho_agent_api::component::ComponentAgentRunSummary, String)>,
        public::ComponentTaskError,
    > {
        wire(
            &self
                .0
                .component_run_history(&native_scope(scope), conversation, before, limit)?,
        )
        .map_err(Into::into)
    }
    fn component_tools(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        run: &str,
    ) -> Result<Vec<public::StoredComponentTool>, public::ComponentTaskError> {
        wire(&self.0.component_tools(&native_scope(scope), run)?).map_err(Into::into)
    }
    fn component_events(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        run: &str,
        after: u64,
        limit: usize,
    ) -> Result<rho_agent_api::component::ComponentAgentEventPage, public::ComponentTaskError> {
        wire(
            &self
                .0
                .component_events(&native_scope(scope), run, after, limit)?,
        )
        .map_err(Into::into)
    }
    fn component_settings(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
    ) -> Result<ComponentModelSettings, public::ComponentTaskError> {
        wire(&self.0.component_settings(&native_scope(scope))?).map_err(Into::into)
    }
    fn write_component_settings(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        expected: u64,
        settings: &ComponentModelSettings,
    ) -> Result<(), public::ComponentTaskError> {
        wire(
            &self
                .0
                .write_component_settings(&native_scope(scope), expected, settings)?,
        )
        .map_err(Into::into)
    }

    fn commit_component(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        write: public::ComponentWrite<'_>,
    ) -> Result<(), public::ComponentTaskError> {
        let conversation = wire(write.conversation)?;
        let run: Option<StoredComponentRun> = write.run.map(wire).transpose()?;
        let tools: Vec<StoredComponentTool> = wire(write.tools)?;
        let events: Vec<ComponentAgentEvent> = wire(write.events)?;
        self.0
            .commit_component(
                &native_scope(scope),
                ComponentWrite {
                    expected_version: write.expected_version,
                    conversation: &conversation,
                    run: run.as_ref(),
                    tools: &tools,
                    events: &events,
                },
            )
            .map_err(Into::into)
    }
}
impl From<public::ComponentTaskError> for ApplicationError {
    fn from(error: public::ComponentTaskError) -> Self {
        use public::ComponentTaskError as E;
        match error {
            E::InvalidInput(v) => Self::InvalidInput(v),
            E::Budget(v) => Self::Budget(v),
            E::Storage(v) => Self::Storage(v),
            E::NotFound => Self::NotFound,
            E::Offline => Self::Offline,
            E::IncarnationChanged => Self::IncarnationChanged,
            E::Conflict => Self::Conflict,
            E::RequestConflict => Self::RequestConflict,
            E::InvalidBridge => Self::InvalidBridge,
            E::Busy {
                message,
                request_id,
            } => Self::Busy {
                message,
                request_id,
            },
            E::AccessDenied { missing } => Self::AccessDenied { missing },
            E::Diagnostic(value) => match wire(&*value) {
                Ok(value) => Self::Diagnostic(Box::new(value)),
                Err(_) => Self::Storage("Agent diagnostic conversion failed".into()),
            },
        }
    }
}
impl From<ApplicationError> for public::ComponentTaskError {
    fn from(error: ApplicationError) -> Self {
        use ApplicationError as E;
        match error {
            E::InvalidInput(v) => Self::InvalidInput(v),
            E::Budget(v) => Self::Budget(v),
            E::Storage(v) => Self::Storage(v),
            E::NotFound => Self::NotFound,
            E::Offline => Self::Offline,
            E::IncarnationChanged => Self::IncarnationChanged,
            E::Conflict => Self::Conflict,
            E::RequestConflict => Self::RequestConflict,
            E::InvalidBridge => Self::InvalidBridge,
            E::Busy {
                message,
                request_id,
            } => Self::Busy {
                message,
                request_id,
            },
            E::AccessDenied { missing } => Self::AccessDenied { missing },
            E::Diagnostic(value) => match wire(&*value) {
                Ok(value) => Self::Diagnostic(Box::new(value)),
                Err(_) => Self::Storage("Agent diagnostic conversion failed".into()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_agent_api::component as api;
    use serde_json::json;

    fn round_trip<N: Serialize + DeserializeOwned, P: Serialize + DeserializeOwned>(value: N) {
        let original = serde_json::to_vec(&value).unwrap();
        let public: P = wire(&value).unwrap();
        assert_eq!(serde_json::to_vec(&public).unwrap(), original);
        assert_eq!(
            component_digest(&value).unwrap(),
            public::component_digest(&public).unwrap()
        );
        let native: N = wire(&public).unwrap();
        assert_eq!(serde_json::to_vec(&native).unwrap(), original);
    }

    #[test]
    fn component_boundary_preserves_document_actions_receipts_and_digests() {
        let document = json!({"document_id":"d","document_version":"v2","selection_version":"s1"});
        let window = json!({"window_id":"window","incarnation":"life"});
        for action in [
            json!({"kind":"open_document","path":"分析.R","expected_context_version":"view"}),
            json!({"kind":"create_document","path":null,"text":"α <- 1\n","expected_context_version":"view"}),
            json!({"kind":"edit_document","document":document,"edits":[{"from":0,"to":1,"insert":"🙂"}]}),
            json!({"kind":"save","document":document,"target_path":"分析.R"}),
            json!({"kind":"run_file","document":document,"target_path":null}),
            json!({"kind":"run_selection","document":document}),
        ] {
            let request:ApplicationCommandRequest=serde_json::from_value(json!({"window":window,"request_id":"original","action":action,"execution_target":{"workspace_instance_id":"main","native_session_id":"native-one"}})).unwrap();
            round_trip::<_, api::ApplicationCommandRequest>(request.clone());
            round_trip::<_, public::ComponentToolAction>(ComponentToolAction::Control(request));
        }
        let receipt:ApplicationCommandReceipt=serde_json::from_value(json!({
            "window":window,"request_id":"original","actor":{"kind":"agent","id":"agent"},"state":"awaiting_execution","created_at_ms":1,"claim_expires_at_ms":400,
            "claimed_at_ms":2,"completed_at_ms":null,"context_version":"v1","diagnostic":"Native result is still pending",
            "capture":{"document":document,"path":"分析.R","base_hash":"base","sha256":"captured","utf8_bytes":17,"run_sha256":"run","native_session_id":"native-one","workspace_instance_id":"main","selection":{"anchor":0,"head":3,"version":"s1"}},
            "save":{"state":"succeeded","client_request_id":"save-request","operation_id":"save-operation","error":null,"verification":{"path":"分析.R","sha256":"saved","source":"native-owner","observed_at_ms":3}},
            "run":{"state":"uncertain","client_request_id":"run-request","operation_id":"run-operation","error":"ack lost"},
            "applied_documents":[document],"save_synchronized":true,
            "applied_document_summaries":[{"document":document,"path":"分析.R","sha256":"draft","base_hash":"base","base_text_present":true,"utf8_bytes":17,"dirty":false,"selection":{"anchor":0,"head":3,"version":"s1"},"readonly_reason":null}]
        })).unwrap();
        round_trip::<_, api::ApplicationCommandReceipt>(receipt);
    }

    #[test]
    fn component_boundary_preserves_captured_calls_and_recovery_states() {
        let invocation = Invocation {
            client_request_id: "original".into(),
            capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
            arguments: json!({"code":"α <- 1","workspace_instance_id":"main"}),
            preconditions: vec![Precondition {
                kind: "workspace.session".into(),
                subject: "active".into(),
                expected: json!("native-one"),
            }],
        };
        round_trip::<_, api::Invocation>(invocation.clone());
        round_trip::<_, public::ComponentToolAction>(ComponentToolAction::Invoke(invocation));
        round_trip::<_, public::ComponentToolAction>(ComponentToolAction::Query(QueryRequest {
            capability: CapabilityRef::new("workspace.list_objects", 1).unwrap(),
            arguments: json!({}),
        }));
        for state in [
            ComponentRecoveryState::Confirmed,
            ComponentRecoveryState::Pending,
            ComponentRecoveryState::Uncertain,
        ] {
            let recovered = ComponentRecoveredTool {
                receipt_id: "tool".into(),
                state,
                operations: vec![ComponentRecoveredOperation {
                    operation_id: OperationId::new("native").unwrap(),
                    status: OperationStatus::Running,
                }],
                documents: vec![],
                application_state: Some(ApplicationCommandState::Uncertain),
                application_request_id: Some("original".into()),
                note: Some("original acknowledgement is missing".into()),
            };
            round_trip::<_, api::ComponentRecoveredTool>(recovered);
        }
    }

    #[test]
    fn component_boundary_preserves_error_categories_and_structured_diagnostics() {
        let diagnostic:Diagnostic=serde_json::from_value(json!({"code":"outcome_uncertain","message":"Check original request","continuation":"inspect_original","next_reads":[{"capability":{"id":"operation.get","version":1},"arguments":{"operation_id":"original"},"purpose":"original owner","missing_identity_fields":[]}]})).unwrap();
        for error in [
            ApplicationError::InvalidInput("input".into()),
            ApplicationError::NotFound,
            ApplicationError::Offline,
            ApplicationError::IncarnationChanged,
            ApplicationError::Conflict,
            ApplicationError::RequestConflict,
            ApplicationError::InvalidBridge,
            ApplicationError::Budget("bounded".into()),
            ApplicationError::Busy {
                message: "busy".into(),
                request_id: Some("original".into()),
            },
            ApplicationError::Storage("uncertain".into()),
            ApplicationError::AccessDenied {
                missing: vec!["native.read".into()],
            },
            ApplicationError::Diagnostic(Box::new(diagnostic)),
        ] {
            let public: public::ComponentTaskError = error.clone().into();
            assert_eq!(ApplicationError::from(public), error);
        }
    }
}
