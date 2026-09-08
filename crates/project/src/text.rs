use super::*;

/// Owner-level progressive-read failures. Adapters classify native facts where observed;
/// message text is never parsed to infer a diagnostic code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectTextError {
    InvalidInput(String),
    ObservationExpired(String),
    ContentChanged(String),
    BudgetExceeded(String),
    Unavailable(String),
}
impl std::fmt::Display for ProjectTextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (kind, message) = match self {
            Self::InvalidInput(message) => ("invalid text request", message),
            Self::ObservationExpired(message) => ("text observation expired", message),
            Self::ContentChanged(message) => ("text content changed", message),
            Self::BudgetExceeded(message) => ("text budget exceeded", message),
            Self::Unavailable(message) => ("text unavailable", message),
        };
        write!(f, "{kind}: {message}")
    }
}
impl std::error::Error for ProjectTextError {}
impl From<ProjectTextError> for OperationError {
    fn from(error: ProjectTextError) -> Self {
        match error {
            ProjectTextError::InvalidInput(message) => Self::InvalidInput(message),
            ProjectTextError::ObservationExpired(message) => Self::ObservationExpired(message),
            ProjectTextError::ContentChanged(message) => Self::ContentChanged(message),
            ProjectTextError::BudgetExceeded(message) => Self::BudgetExceeded(message),
            ProjectTextError::Unavailable(message) => Self::Unavailable(message),
        }
    }
}

fn validate_cursor(cursor: &TextCursor) -> Result<(), OperationError> {
    validate_path(&cursor.file.path).map_err(invalid)?;
    if cursor.line == 0 || cursor.byte_offset > cursor.file.byte_size {
        return Err(invalid("invalid text continuation position"));
    }
    Ok(())
}
pub fn validate_read(args: &ReadTextArguments) -> Result<(), OperationError> {
    validate_path(&args.path).map_err(invalid)?;
    if args.start_line == 0 || !(1..=200).contains(&args.limit_lines) {
        return Err(invalid("text lines start at 1; page limit is 1..=200"));
    }
    if let Some(cursor) = &args.continuation {
        validate_cursor(cursor)?;
    }
    Ok(())
}
pub fn validate_search(args: &SearchTextArguments) -> Result<(), OperationError> {
    if args.text.is_empty() || args.text.len() > 1024 || !(1..=100).contains(&args.limit_matches) {
        return Err(invalid(
            "literal text must be 1..=1024 UTF-8 bytes; match limit is 1..=100",
        ));
    }
    if !args.directory.is_empty() {
        validate_path(&args.directory).map_err(invalid)?;
    }
    if args
        .filename_contains
        .as_ref()
        .is_some_and(|s| s.len() > 1024 || s.contains('/'))
    {
        return Err(invalid(
            "filename filter must be a basename substring of at most 1024 bytes",
        ));
    }
    if let Some(cursor) = &args.continuation {
        if cursor.directories.len() > 64 {
            return Err(invalid("directory continuation exceeds 64 levels"));
        }
        for frame in &cursor.directories {
            if !frame.path.is_empty() {
                validate_path(&frame.path).map_err(invalid)?;
            }
            if frame
                .after_name
                .as_ref()
                .is_some_and(|s| s.len() > 1024 || s.contains('/'))
            {
                return Err(invalid("invalid directory continuation name"));
            }
        }
        if let Some(active) = &cursor.active_file {
            validate_cursor(active)?;
        }
    }
    Ok(())
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
                $validate(&args)?;
                serde_json::to_value(args).map_err(invalid)
            }
            async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
                let args: $args = serde_json::from_value(value.clone()).map_err(invalid)?;
                $validate(&args)?;
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
                    Err(error) => return Err(error.into()),
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
