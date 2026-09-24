use crate::*;

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
