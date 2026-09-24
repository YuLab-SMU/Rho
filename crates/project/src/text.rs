use super::*;
use rho_files_api::{validate_read, validate_search};

fn text_error(error: ProjectTextError) -> OperationError {
    match error {
        ProjectTextError::InvalidInput(message) => OperationError::InvalidInput(message),
        ProjectTextError::ObservationExpired(message) => OperationError::ObservationExpired(message),
        ProjectTextError::ContentChanged(message) => OperationError::ContentChanged(message),
        ProjectTextError::BudgetExceeded(message) => OperationError::BudgetExceeded(message),
        ProjectTextError::Unavailable(message) => OperationError::Unavailable(message),
    }
}

trait InvestigationCompleteness {
    fn no_skipped_content(&self) -> bool;
}
impl InvestigationCompleteness for TextPage {
    fn no_skipped_content(&self) -> bool {
        self.skipped.is_none()
    }
}
impl InvestigationCompleteness for SearchTextPage {
    fn no_skipped_content(&self) -> bool {
        self.skipped.is_empty()
    }
}

macro_rules! handler {
    ($name:ident, $args:ty, $result:ty, $cap:literal, $method:ident, $validate:ident) => {
        pub struct $name {
            owner: Arc<ProjectOwner>,
            descriptor: CapabilityDescriptor,
        }
        impl $name {
            pub fn new(owner: Arc<ProjectOwner>) -> Self {
                Self {
                    owner,
                    descriptor: descriptor(
                        $cap,
                        CapabilityKind::Query,
                        schema_for!($args).to_value(),
                        schema_for!($result).to_value(),
                    ),
                }
            }
        }
        #[async_trait]
        impl QueryHandler for $name {
            fn descriptor(&self) -> &CapabilityDescriptor {
                &self.descriptor
            }
            fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
                let args: $args = serde_json::from_value(value.clone()).map_err(invalid)?;
                $validate(&args).map_err(text_error)?;
                serde_json::to_value(args).map_err(invalid)
            }
            async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
                let args: $args = serde_json::from_value(value.clone()).map_err(invalid)?;
                $validate(&args).map_err(text_error)?;
                let mut reply = QuerySnapshot {
                    next_reads: Vec::new(),
                    diagnostics: Vec::new(),
                    target: self.owner.target(),
                    source: "filesystem/text".into(),
                    observed_at_ms: SystemClock.now_ms()?,
                    status: QueryStatus::Ready,
                    completeness: ObservationCompleteness::Partial,
                    data: None,
                    notices: vec![],
                };
                match self.owner.runtime.$method(&args).await {
                    Ok(page) => {
                        if page.complete && page.no_skipped_content() {
                            reply.completeness = ObservationCompleteness::Complete;
                        }
                        reply.data = Some(serde_json::to_value(page).map_err(invalid)?);
                        if let Some(cursor) = reply
                            .data
                            .as_ref()
                            .and_then(|data| data.get("continuation"))
                            .filter(|cursor| !cursor.is_null())
                        {
                            let mut arguments = value.clone();
                            arguments["continuation"] = cursor.clone();
                            reply.next_reads.push(rho_contract::NextRead::query(
                                $cap,
                                "Continue the same version-bound text investigation",
                                arguments,
                            ));
                        }
                    }
                    Err(error) => return Err(text_error(error)),
                }
                Ok(reply)
            }
        }
    };
}
handler!(
    ProjectReadTextHandler,
    ReadTextArguments,
    TextPage,
    "project.read_text",
    read_text,
    validate_read
);
handler!(
    ProjectSearchTextHandler,
    SearchTextArguments,
    SearchTextPage,
    "project.search_text",
    search_text,
    validate_search
);

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    use rho_contract::{CallContext, CallerIdentity, CallerKind, DiagnosticCode, QueryRequest};
    use rho_operation::{CapabilityRegistry, QueryGateway};
    struct FailureRuntime(ProjectTextError);
    #[async_trait]
    impl ProjectRuntime for FailureRuntime {
        fn root(&self) -> &str {
            "/project"
        }
        async fn snapshot(&self, _: &[String], _: usize) -> Result<ProjectSnapshot, String> {
            Err("not called".into())
        }
        async fn patch_paths(&self, _: &str) -> Result<Vec<String>, String> {
            Err("not called".into())
        }
        async fn check_patch(&self, _: &str) -> Result<(), String> {
            Err("not called".into())
        }
        async fn apply_patch(&self, _: &str) -> GitApplyReport {
            panic!("text diagnostics must never apply a patch")
        }
        async fn read_text(&self, _: &ReadTextArguments) -> Result<TextPage, ProjectTextError> {
            Err(self.0.clone())
        }
        async fn search_text(
            &self,
            _: &SearchTextArguments,
        ) -> Result<SearchTextPage, ProjectTextError> {
            Err(self.0.clone())
        }
    }
    #[tokio::test]
    async fn typed_native_failures_reach_the_shared_gateway_without_message_inference() {
        let context = CallContext {
            caller: CallerIdentity {
                kind: CallerKind::Agent,
                id: "text-reader".into(),
            },
            principal: None,
            scopes: BTreeSet::from([PROJECT_READ_SCOPE.into()]),
            connection_id: "test".into(),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        };
        for (failure, code) in [
            (
                ProjectTextError::ContentChanged("Observed bytes differ".into()),
                DiagnosticCode::ContentChanged,
            ),
            (
                ProjectTextError::ObservationExpired("Native project identity ended".into()),
                DiagnosticCode::ObservationExpired,
            ),
            (
                ProjectTextError::BudgetExceeded("Cursor cannot fit".into()),
                DiagnosticCode::BudgetExceeded,
            ),
            (
                ProjectTextError::InvalidInput("Cursor does not match the request".into()),
                DiagnosticCode::InvalidInput,
            ),
            // This text intentionally contains another code; only the typed variant decides the diagnostic.
            (
                ProjectTextError::Unavailable(
                    "content_changed appears in an OS error message".into(),
                ),
                DiagnosticCode::Unavailable,
            ),
        ] {
            let owner = Arc::new(ProjectOwner::new(
                Arc::new(FailureRuntime(failure)),
                Arc::new(Mutex::new(())),
            ));
            let mut registry = CapabilityRegistry::new();
            registry
                .register_query(Arc::new(ProjectReadTextHandler::new(owner.clone())))
                .unwrap();
            registry
                .register_query(Arc::new(ProjectSearchTextHandler::new(owner)))
                .unwrap();
            let gateway = QueryGateway::new(Arc::new(registry));
            for (capability, arguments) in [
                ("project.read_text", json!({"path":"analysis.R"})),
                ("project.search_text", json!({"text":"literal"})),
            ] {
                let error = gateway
                    .query(
                        &context,
                        QueryRequest {
                            capability: CapabilityRef::new(capability, 1).unwrap(),
                            arguments,
                        },
                    )
                    .await
                    .unwrap_err();
                assert_eq!(error.diagnostic().code, code, "{capability}: {error}");
            }
        }
    }
}
