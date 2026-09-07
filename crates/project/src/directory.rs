use super::*;
use rho_contract::ListDirectoryArguments;

pub struct ProjectDirectoryHandler {
    owner: Arc<ProjectOwner>,
    descriptor: CapabilityDescriptor,
}
impl ProjectDirectoryHandler {
    pub fn new(owner: Arc<ProjectOwner>) -> Self {
        Self {
            owner,
            descriptor: descriptor(
                "project.list_directory",
                CapabilityKind::Query,
                schema_for!(ListDirectoryArguments).to_value(),
                schema_for!(QuerySnapshot).to_value(),
            ),
        }
    }
    fn parse(&self, value: &Value) -> Result<ListDirectoryArguments, OperationError> {
        let args: ListDirectoryArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        if !args.path.is_empty() {
            validate_path(&args.path).map_err(invalid)?;
        }
        if !(1..=200).contains(&args.limit)
            || args
                .after_name
                .as_ref()
                .is_some_and(|n| n.len() > 1024 || n.contains('/'))
        {
            return Err(invalid("invalid directory page bounds"));
        }
        Ok(args)
    }
}
#[async_trait]
impl QueryHandler for ProjectDirectoryHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        serde_json::to_value(self.parse(value)?).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args = self.parse(value)?;
        // Directory metadata is a bounded filesystem observation; it does not query R.
        let result = self.owner.runtime.list_directory(&args).await;
        let (status, data, notices) = match result {
            Ok(page) => (
                QueryStatus::Ready,
                Some(serde_json::to_value(page).map_err(invalid)?),
                Vec::new(),
            ),
            Err(error) => (QueryStatus::Unavailable, None, vec![error]),
        };
        Ok(QuerySnapshot {
            target: self.owner.target(),
            source: "filesystem".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status,
            completeness: ObservationCompleteness::Partial,
            data,
            notices,
        })
    }
}
