use super::*;

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
                    Err(error) => {
                        reply.status = QueryStatus::Unavailable;
                        reply.notices.push(error);
                    }
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
