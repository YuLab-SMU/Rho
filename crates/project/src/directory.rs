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
                schema_for!(rho_contract::DirectoryPage).to_value(),
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
            next_reads: Vec::new(),
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
        if args.text.trim().is_empty() || args.text.len() > 1024 {
            return Err(invalid("Search text must be 1..=1024 bytes"));
        }
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args: rho_contract::SearchFilesArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        let mut cursor = args
            .continuation
            .clone()
            .unwrap_or_else(|| SearchFilesCursor {
                project: self.owner.runtime.root().into(),
                text: args.text.clone(),
                show_hidden: args.show_hidden,
                directories: vec![DirectoryScanFrame {
                    path: String::new(),
                    after_name: None,
                }],
            });
        if cursor.project != self.owner.runtime.root()
            || cursor.text != args.text
            || cursor.show_hidden != args.show_hidden
            || cursor.directories.len() > 64
        {
            return Err(invalid("path search continuation project/query mismatch"));
        }
        let mut result = rho_contract::FileSearchResult {
            entries: vec![],
            scanned_entries: 0,
            scanned_directories: 0,
            truncated: false,
            notices: vec![],
            continuation: None,
        };
        let needle = args.text.to_lowercase();
        let mut cache: Option<(
            String,
            std::collections::VecDeque<rho_contract::DirectoryEntry>,
        )> = None;
        while !cursor.directories.is_empty() {
            result.continuation = Some(cursor.clone());
            if result.scanned_entries >= 10000
                || result.scanned_directories >= 200
                || result.entries.len() >= 200
                || serde_json::to_vec(&result).map_err(invalid)?.len() > 56 * 1024
            {
                result.truncated = true;
                result.notices.push("Page budget reached; continue with the unchanged query and returned continuation.".into());
                break;
            }
            let frame = cursor.directories.last_mut().unwrap();
            if !frame.path.is_empty() {
                validate_path(&frame.path).map_err(invalid)?;
            }
            if frame
                .after_name
                .as_ref()
                .is_some_and(|name| name.len() > 1024 || name.contains('/'))
            {
                return Err(invalid("invalid path continuation name"));
            }
            if frame.after_name.is_none() {
                result.scanned_directories += 1;
            }
            let page = if cache
                .as_ref()
                .is_some_and(|(path, entries)| path == &frame.path && !entries.is_empty())
            {
                let (_, entries) = cache.as_mut().unwrap();
                Ok(DirectoryPage {
                    path: frame.path.clone(),
                    entries: vec![entries.pop_front().unwrap()],
                    next_name: None,
                    truncated: false,
                    notices: vec![],
                })
            } else {
                match self
                    .owner
                    .runtime
                    .list_directory(&ListDirectoryArguments {
                        path: frame.path.clone(),
                        after_name: frame.after_name.clone(),
                        limit: 200,
                    })
                    .await
                {
                    Ok(mut page) => {
                        let mut entries: std::collections::VecDeque<_> =
                            page.entries.drain(..).collect();
                        page.entries = entries.pop_front().into_iter().collect();
                        cache = Some((frame.path.clone(), entries));
                        Ok(page)
                    }
                    Err(error) => Err(error),
                }
            };
            match page {
                Ok(page) => {
                    if page.truncated {
                        result.notices.extend(page.notices);
                        result.truncated = true;
                    }
                    let Some(entry) = page.entries.into_iter().next() else {
                        cursor.directories.pop();
                        continue;
                    };
                    frame.after_name = Some(entry.name.clone());
                    result.scanned_entries += 1;
                    if !args.show_hidden && entry.name.starts_with('.') {
                        continue;
                    }
                    if entry.kind == "directory" {
                        if cursor.directories.len() == 64 {
                            result.truncated = true;
                            result.notices.push(format!("Directory depth exceeds 64 at {}; enumerate that directory explicitly.",entry.path));
                        } else {
                            cursor.directories.push(DirectoryScanFrame {
                                path: entry.path.clone(),
                                after_name: None,
                            });
                        }
                    }
                    if entry.path.to_lowercase().contains(&needle) {
                        result.entries.push(entry);
                    }
                }
                Err(error) => {
                    result.truncated = true;
                    result.notices.push(error);
                    cursor.directories.pop();
                }
            }
        }
        result.continuation = (!cursor.directories.is_empty()).then_some(cursor);
        if serde_json::to_vec(&result).map_err(invalid)?.len() > 64 * 1024 {
            return Err(invalid(
                "path search continuation exceeds 64 KiB; browse a narrower directory",
            ));
        }
        Ok(QuerySnapshot {
            next_reads: Vec::new(),
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
