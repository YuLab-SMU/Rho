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
                schema_for!(QuerySnapshot).to_value(),
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
        if args.text.trim().is_empty() || args.text.len() > 1024 {
            return Err(invalid("Search text must be 1..=1024 bytes"));
        }
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args: rho_contract::SearchFilesArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        let mut remaining = std::collections::VecDeque::from([(String::new(), None)]);
        let mut result = rho_contract::FileSearchResult {
            entries: vec![],
            scanned_entries: 0,
            scanned_directories: 0,
            truncated: false,
            notices: vec![],
        };
        let needle = args.text.to_lowercase();
        while let Some((path, after_name)) = remaining.pop_front() {
            if result.scanned_entries >= 10000
                || result.scanned_directories >= 200
                || result.entries.len() >= 200
            {
                result.truncated = true;
                break;
            }
            if after_name.is_none() {
                result.scanned_directories += 1;
            }
            match self
                .owner
                .runtime
                .list_directory(&ListDirectoryArguments {
                    path,
                    after_name,
                    limit: 200,
                })
                .await
            {
                Ok(page) => {
                    if let Some(next) = page.next_name {
                        remaining.push_back((page.path, Some(next)));
                    }
                    result.scanned_entries += page.entries.len() as u32;
                    for entry in page.entries {
                        if !args.show_hidden && entry.name.starts_with('.') {
                            continue;
                        }
                        if entry.kind == "directory" {
                            remaining.push_back((entry.path.clone(), None));
                        }
                        if entry.path.to_lowercase().contains(&needle) {
                            if result.entries.len() < 200 {
                                result.entries.push(entry);
                            } else {
                                result.truncated = true;
                            }
                        }
                    }
                }
                Err(error) => {
                    result.truncated = true;
                    if result.notices.len() < 10 {
                        result.notices.push(error);
                    }
                }
            }
        }
        if result.truncated {
            result.notices.push("Search is bounded to 200 results, 200 directories and 10,000 entries. Refine the name or browse a directory.".into());
        }
        Ok(QuerySnapshot {
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
