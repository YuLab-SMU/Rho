use crate::*;

pub fn validate_patch(args: &ApplyPatchArguments) -> Result<(), String> {
    if args.patch.trim().is_empty() || args.patch.len() > MAX_PATCH_BYTES || args.patch.contains('\0') {
        return Err("patch must contain 1..=204800 non-NUL bytes".into());
    }
    Ok(())
}
pub fn validate_search_files(args: &SearchFilesArguments) -> Result<(), String> {
    if args.text.trim().is_empty() || args.text.len() > 1024 {
        return Err("Search text must be 1..=1024 bytes".into());
    }
    Ok(())
}
pub fn validate_directory(args: &ListDirectoryArguments) -> Result<(), String> {
    if !args.path.is_empty() { validate_path(&args.path)?; }
    if !(1..=200).contains(&args.limit) || args.after_name.as_ref().is_some_and(|n| n.len() > 1024 || n.contains('/')) {
        return Err("invalid directory page bounds".into());
    }
    Ok(())
}
pub fn validate_snapshot(args: &mut ProjectSnapshotArguments) -> Result<(), String> {
    if args.paths.len() > MAX_PROJECT_PATHS || !(1..=200).contains(&args.limit) {
        return Err("project snapshot accepts at most 64 paths and a limit of 1..=200".into());
    }
    for path in &args.paths { validate_path(path)?; }
    args.paths.sort();
    args.paths.dedup();
    Ok(())
}
pub fn validate_read_file(args: &ReadFileArguments) -> Result<(), String> {
    validate_path(&args.path)?;
    if !(1..=65536).contains(&args.limit_bytes) {
        return Err("file page limit must be 1..=65536 bytes".into());
    }
    Ok(())
}

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
fn validate_cursor(cursor: &TextCursor) -> Result<(), ProjectTextError> {
    validate_path(&cursor.file.path).map_err(ProjectTextError::InvalidInput)?;
    if cursor.line == 0 || cursor.byte_offset > cursor.file.byte_size {
        return Err(ProjectTextError::InvalidInput("invalid text continuation position".into()));
    }
    Ok(())
}
pub fn validate_read(args: &ReadTextArguments) -> Result<(), ProjectTextError> {
    validate_path(&args.path).map_err(ProjectTextError::InvalidInput)?;
    if args.start_line == 0 || !(1..=200).contains(&args.limit_lines) {
        return Err(ProjectTextError::InvalidInput("text lines start at 1; page limit is 1..=200".into()));
    }
    if let Some(cursor) = &args.continuation {
        validate_cursor(cursor)?;
    }
    Ok(())
}
pub fn validate_search(args: &SearchTextArguments) -> Result<(), ProjectTextError> {
    if args.text.is_empty() || args.text.len() > 1024 || !(1..=100).contains(&args.limit_matches) {
        return Err(ProjectTextError::InvalidInput(
            "literal text must be 1..=1024 UTF-8 bytes; match limit is 1..=100".into(),
        ));
    }
    if !args.directory.is_empty() {
        validate_path(&args.directory).map_err(ProjectTextError::InvalidInput)?;
    }
    if args
        .filename_contains
        .as_ref()
        .is_some_and(|s| s.len() > 1024 || s.contains('/'))
    {
        return Err(ProjectTextError::InvalidInput(
            "filename filter must be a basename substring of at most 1024 bytes".into(),
        ));
    }
    if let Some(cursor) = &args.continuation {
        if cursor.directories.len() > 64 {
            return Err(ProjectTextError::InvalidInput("directory continuation exceeds 64 levels".into()));
        }
        for frame in &cursor.directories {
            if !frame.path.is_empty() {
                validate_path(&frame.path).map_err(ProjectTextError::InvalidInput)?;
            }
            if frame
                .after_name
                .as_ref()
                .is_some_and(|s| s.len() > 1024 || s.contains('/'))
            {
                return Err(ProjectTextError::InvalidInput("invalid directory continuation name".into()));
            }
        }
        if let Some(active) = &cursor.active_file {
            validate_cursor(active)?;
        }
    }
    Ok(())
}
