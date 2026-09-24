use super::*;
use rho_contract::{ListDirectoryArguments, NextRead};

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
                schema_for!(rho_contract::DirectoryPage).to_value(),
            ),
        }
    }
    fn parse(&self, value: &Value) -> Result<ListDirectoryArguments, OperationError> {
        let args: ListDirectoryArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        rho_files_api::validate_directory(&args).map_err(invalid)?;
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
        let mut next_reads = Vec::new();
        if let Some(next_name) = data
            .as_ref()
            .and_then(|page| page.get("next_name"))
            .filter(|name| !name.is_null())
        {
            let mut next = serde_json::to_value(&args).map_err(invalid)?;
            next["after_name"] = next_name.clone();
            next_reads.push(NextRead::query(
                "project.list_directory",
                "Continue directory enumeration after the last returned name",
                next,
            ));
        }
        Ok(QuerySnapshot {
            next_reads,
            diagnostics: Vec::new(),
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

pub struct ProjectSearchHandler {
    owner: Arc<ProjectOwner>,
    descriptor: CapabilityDescriptor,
}
impl ProjectSearchHandler {
    pub fn new(owner: Arc<ProjectOwner>) -> Self {
        Self {
            owner,
            descriptor: descriptor(
                "project.search_files",
                CapabilityKind::Query,
                schema_for!(rho_contract::SearchFilesArguments).to_value(),
                schema_for!(rho_contract::FileSearchResult).to_value(),
            ),
        }
    }
}
#[async_trait]
impl QueryHandler for ProjectSearchHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: rho_contract::SearchFilesArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        rho_files_api::validate_search_files(&args).map_err(invalid)?;
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args: rho_contract::SearchFilesArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        let result = rho_files_owner::search_files(self.owner.runtime.as_ref(), &args).await.map_err(invalid)?;
        let mut next_reads = Vec::new();
        if let Some(cursor) = &result.continuation {
            let mut next = serde_json::to_value(&args).map_err(invalid)?;
            next["continuation"] = serde_json::to_value(cursor).map_err(invalid)?;
            next_reads.push(NextRead::query(
                "project.search_files",
                "Continue the same path search from its bounded scan position",
                next,
            ));
        }
        Ok(QuerySnapshot {
            next_reads,
            diagnostics: Vec::new(),
            target: self.owner.target(),
            source: "filesystem/search".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Partial,
            data: Some(serde_json::to_value(result).map_err(invalid)?),
            notices: vec![],
        })
    }
}
