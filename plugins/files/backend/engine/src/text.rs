use super::*;
use rho_files_api::*;

const PAGE_BYTES: usize = 64 * 1024;
const MATCH_SCAN_BYTES: usize = 1024 * 1024;
const VERIFY_BYTES: u64 = 64 * 1024 * 1024;
const SCAN_ENTRIES: u32 = 200;

#[derive(Debug)]
struct TextData {
    identity: TextIdentity,
    text: String,
    bom: usize,
}
fn skip(path: &str, reason: TextSkipReason, detail: impl Into<String>) -> TextSkip {
    TextSkip {
        path: path.into(),
        reason,
        detail: detail.into(),
    }
}
#[derive(Debug)]
enum TextLoadError {
    Skipped {
        record: TextSkip,
        pinned: ProjectTextError,
    },
    Failure(ProjectTextError),
}
impl TextLoadError {
    fn into_pinned(self) -> ProjectTextError {
        match self {
            Self::Skipped { pinned, .. } | Self::Failure(pinned) => pinned,
        }
    }
}
impl From<ProjectTextError> for TextLoadError {
    fn from(error: ProjectTextError) -> Self {
        Self::Failure(error)
    }
}
fn skipped(path: &str, reason: TextSkipReason, detail: impl Into<String>) -> TextLoadError {
    let detail = detail.into();
    let pinned = if matches!(reason, TextSkipReason::Unreadable) {
        ProjectTextError::Unavailable(format!("Pinned file {path} cannot be read: {detail}"))
    } else {
        ProjectTextError::ContentChanged(format!(
            "Pinned file {path} no longer has its observed readable representation: {detail}"
        ))
    };
    TextLoadError::Skipped {
        record: skip(path, reason, detail),
        pinned,
    }
}
fn skipped_io(path: &str, error: std::io::Error) -> TextLoadError {
    let pinned = if error.kind() == std::io::ErrorKind::NotFound {
        ProjectTextError::ContentChanged(format!("Pinned file {path} no longer exists"))
    } else {
        ProjectTextError::Unavailable(format!("Cannot read {path}: {error}"))
    };
    TextLoadError::Skipped {
        record: skip(path, TextSkipReason::Unreadable, error.to_string()),
        pinned,
    }
}

fn native_identity(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{:?}:{:?}:{}",
            metadata.created().ok(),
            metadata.modified().ok(),
            metadata.len()
        )
    }
}
fn json_size(value: &impl serde::Serialize) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |v| v.len())
}

impl GitProject {
    fn check_text_root(&self) -> Result<(), ProjectTextError> {
        let observed = std::fs::symlink_metadata(&self.root).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectTextError::ObservationExpired(
                    "The selected project root no longer exists".into(),
                )
            } else {
                ProjectTextError::Unavailable(format!(
                    "Cannot inspect the selected project root: {error}"
                ))
            }
        })?;
        if !observed.is_dir() || observed.file_type().is_symlink() {
            return Err(ProjectTextError::ObservationExpired(
                "The selected project root changed or became a symbolic link".into(),
            ));
        }
        let canonical = self.root.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectTextError::ObservationExpired(
                    "The selected project root changed during validation".into(),
                )
            } else {
                ProjectTextError::Unavailable(format!(
                    "Cannot resolve the selected project root: {error}"
                ))
            }
        })?;
        if canonical != self.root {
            return Err(ProjectTextError::ObservationExpired(
                "The selected project root identity changed".into(),
            ));
        }
        Ok(())
    }
    /// Preserve native classifications while applying the same containment rules as checked_path.
    fn checked_text_path(&self, path: &str) -> Result<PathBuf, TextLoadError> {
        self.check_text_root()?;
        rho_files_api::validate_path(path).map_err(ProjectTextError::InvalidInput)?;
        let result = self.root.join(path);
        if self
            .excluded
            .iter()
            .any(|excluded| result == *excluded || result.starts_with(excluded))
        {
            return Err(skipped(
                path,
                TextSkipReason::InvalidPath,
                "Path refers to Host-owned application data",
            ));
        }
        let mut current = self.root.clone();
        let components = path.split('/').collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            current.push(component);
            match std::fs::symlink_metadata(&current) {
                Ok(metadata)
                    if index + 1 < components.len() && metadata.file_type().is_symlink() =>
                {
                    return Err(skipped(
                        path,
                        TextSkipReason::Symlink,
                        "Project paths must not traverse symbolic links",
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(skipped_io(path, error)),
            }
        }
        Ok(result)
    }
    async fn load_text(
        &self,
        path: &str,
        expected: Option<&TextIdentity>,
        expected_digest: Option<&str>,
    ) -> Result<TextData, TextLoadError> {
        let resolved = self.checked_text_path(path)?;
        let before =
            std::fs::symlink_metadata(&resolved).map_err(|error| skipped_io(path, error))?;
        if expected.is_some_and(|identity| {
            identity.native_identity != native_identity(&before)
                || identity.byte_size != before.len()
        }) {
            return Err(ProjectTextError::ContentChanged(
                "Pinned file identity changed before reading".into(),
            )
            .into());
        }
        if before.file_type().is_symlink() {
            return Err(skipped(
                path,
                TextSkipReason::Symlink,
                "Text reads do not follow symbolic links",
            ));
        }
        if !before.is_file() {
            return Err(skipped(
                path,
                TextSkipReason::Unsupported,
                "Text requires a regular file",
            ));
        }
        if before.len() > MAX_FILE_BYTES {
            return Err(skipped(
                path,
                TextSkipReason::Oversize,
                "Text identity verification is limited to 64 MiB per file",
            ));
        }
        let mut file = tokio::fs::File::open(&resolved)
            .await
            .map_err(|error| skipped_io(path, error))?;
        let opened = file
            .metadata()
            .await
            .map_err(|error| skipped_io(path, error))?;
        if native_identity(&opened) != native_identity(&before) {
            return Err(
                ProjectTextError::ContentChanged("File was replaced during open".into()).into(),
            );
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| TextLoadError::Failure(skipped_io(path, error).into_pinned()))?;
        self.checked_text_path(path)
            .map_err(|error| TextLoadError::Failure(error.into_pinned()))?;
        let after = std::fs::symlink_metadata(&resolved)
            .map_err(|error| TextLoadError::Failure(skipped_io(path, error).into_pinned()))?;
        let after_open = file
            .metadata()
            .await
            .map_err(|error| TextLoadError::Failure(skipped_io(path, error).into_pinned()))?;
        if native_identity(&before) != native_identity(&after)
            || native_identity(&before) != native_identity(&after_open)
            || after.file_type().is_symlink()
            || bytes.len() as u64 != before.len()
        {
            return Err(ProjectTextError::ContentChanged(
                "File changed during identity verification".into(),
            )
            .into());
        }
        let sha256 = hash(&bytes);
        if expected_digest.is_some_and(|digest| digest != sha256)
            || expected.is_some_and(|identity| identity.sha256 != sha256)
        {
            return Err(ProjectTextError::ContentChanged(
                "Expected file digest does not match the verified bytes".into(),
            )
            .into());
        }
        if bytes.contains(&0) {
            return Err(skipped(
                path,
                TextSkipReason::Binary,
                "NUL bytes indicate binary or unsupported non-UTF-8 text",
            ));
        }
        let bom = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            3
        } else {
            0
        };
        let text = String::from_utf8(bytes).map_err(|_| {
            skipped(
                path,
                TextSkipReason::InvalidEncoding,
                "Only valid UTF-8 and UTF-8 BOM text are supported",
            )
        })?;
        Ok(TextData {
            identity: TextIdentity {
                path: path.into(),
                sha256,
                native_identity: native_identity(&before),
                byte_size: before.len(),
                encoding: if bom == 3 { "utf-8-bom" } else { "utf-8" }.into(),
            },
            text,
            bom,
        })
    }
    fn cursor(&self, data: &TextData, byte: usize, line: u64) -> TextCursor {
        TextCursor {
            project: self.identity.clone(),
            file: data.identity.clone(),
            byte_offset: byte as u64,
            line,
        }
    }
    fn verify_cursor(
        &self,
        data: &TextData,
        cursor: &TextCursor,
    ) -> Result<(usize, u64), ProjectTextError> {
        if cursor.project != self.identity {
            return Err(ProjectTextError::ObservationExpired(
                "Text continuation belongs to a different project".into(),
            ));
        }
        if cursor.file != data.identity {
            return Err(ProjectTextError::ContentChanged("Text continuation no longer identifies the observed file version; restart the read".into()));
        }
        let byte = usize::try_from(cursor.byte_offset)
            .map_err(|error| ProjectTextError::InvalidInput(error.to_string()))?;
        if byte < data.bom
            || byte > data.text.len()
            || !data.text.is_char_boundary(byte)
            || cursor.line
                != 1 + data.text.as_bytes()[data.bom..byte]
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count() as u64
        {
            return Err(ProjectTextError::InvalidInput(
                "Invalid text continuation position".into(),
            ));
        }
        Ok((byte, cursor.line))
    }
    pub(super) async fn read_text_page(
        &self,
        args: &ReadTextArguments,
    ) -> Result<TextPage, ProjectTextError> {
        if args.start_line == 0 || !(1..=200).contains(&args.limit_lines) {
            return Err(ProjectTextError::InvalidInput(
                "Invalid text line bounds".into(),
            ));
        }
        if let Some(cursor) = &args.continuation {
            if cursor.file.path != args.path {
                return Err(ProjectTextError::InvalidInput(
                    "Text continuation path mismatch".into(),
                ));
            }
            if cursor.project != self.identity {
                return Err(ProjectTextError::ObservationExpired(
                    "Text continuation belongs to a different project".into(),
                ));
            }
        }
        let data = match self
            .load_text(
                &args.path,
                args.continuation.as_ref().map(|cursor| &cursor.file),
                args.expected_sha256.as_deref(),
            )
            .await
        {
            Ok(data) => data,
            Err(error)
                if args.continuation.is_some()
                    || (args.expected_sha256.is_some()
                        && !matches!(
                            &error,
                            TextLoadError::Skipped {
                                record: TextSkip {
                                    reason: TextSkipReason::Binary
                                        | TextSkipReason::InvalidEncoding,
                                    ..
                                },
                                ..
                            }
                        )) =>
            {
                // Binary/encoding skips occur after expected digest verification; matching
                // unsupported bytes remain explicit skipped data rather than a false change.
                return Err(error.into_pinned());
            }
            Err(TextLoadError::Failure(error)) => return Err(error),
            Err(TextLoadError::Skipped {
                record: skipped, ..
            }) => {
                return Ok(TextPage {
                    file: None,
                    fragments: vec![],
                    skipped: Some(skipped),
                    continuation: None,
                    complete: true,
                    limit_reason: None,
                });
            }
        };
        if args
            .expected_sha256
            .as_ref()
            .is_some_and(|digest| digest != &data.identity.sha256)
        {
            return Err(ProjectTextError::ContentChanged(
                "Expected file digest does not match".into(),
            ));
        }
        let (mut offset, mut line) = if let Some(cursor) = &args.continuation {
            if cursor.file.path != args.path {
                return Err(ProjectTextError::InvalidInput(
                    "Text continuation path mismatch".into(),
                ));
            }
            self.verify_cursor(&data, cursor)?
        } else {
            let mut offset = data.bom;
            let mut line = 1;
            while line < args.start_line && offset < data.text.len() {
                offset = data.text[offset..]
                    .find('\n')
                    .map_or(data.text.len(), |i| offset + i + 1);
                line += 1;
            }
            (offset, line)
        };
        let mut page = TextPage {
            file: Some(data.identity.clone()),
            fragments: vec![],
            skipped: None,
            continuation: None,
            complete: false,
            limit_reason: None,
        };
        while offset < data.text.len() && page.fragments.len() < args.limit_lines as usize {
            let line_end = data.text[offset..]
                .find('\n')
                .map_or(data.text.len(), |i| offset + i + 1);
            let mut end = line_end.min(offset + 24 * 1024);
            while !data.text.is_char_boundary(end) {
                end -= 1;
            }
            loop {
                let complete = end == line_end;
                page.fragments.push(TextFragment {
                    line,
                    byte_start: offset as u64,
                    byte_end: end as u64,
                    text: data.text[offset..end].into(),
                    line_complete: complete,
                });
                page.continuation = (end < data.text.len()).then(|| {
                    self.cursor(
                        &data,
                        end,
                        line + u64::from(complete && data.text.as_bytes()[end - 1] == b'\n'),
                    )
                });
                page.limit_reason = page
                    .continuation
                    .as_ref()
                    .map(|_| "line_or_utf8_byte_budget".into());
                if json_size(&page) <= PAGE_BYTES {
                    break;
                }
                page.fragments.pop();
                if end - offset <= 4 {
                    page.continuation = Some(self.cursor(&data, offset, line));
                    return Ok(page);
                }
                end = offset + (end - offset) / 2;
                while !data.text.is_char_boundary(end) {
                    end -= 1;
                }
            }
            if data.text.as_bytes()[end - 1] == b'\n' {
                line += 1;
            }
            offset = end;
        }
        page.continuation = (offset < data.text.len()).then(|| self.cursor(&data, offset, line));
        page.complete = page.continuation.is_none();
        page.limit_reason = page
            .continuation
            .as_ref()
            .map(|_| "line_or_utf8_byte_budget".into());
        Ok(page)
    }
}

fn match_length(haystack: &str, needle: &str, sensitive: bool) -> Option<usize> {
    if sensitive {
        return haystack.starts_with(needle).then_some(needle.len());
    }
    if needle.is_ascii()
        && haystack
            .as_bytes()
            .get(..needle.len())
            .is_some_and(|s| s.is_ascii())
    {
        return haystack
            .as_bytes()
            .get(..needle.len())
            .filter(|s| s.eq_ignore_ascii_case(needle.as_bytes()))
            .map(|_| needle.len());
    }
    let needle = needle.to_lowercase();
    let mut folded = String::new();
    for (offset, character) in haystack.char_indices() {
        folded.extend(character.to_lowercase());
        if folded == needle {
            return Some(offset + character.len_utf8());
        }
        if !needle.starts_with(&folded) {
            return None;
        }
    }
    None
}

fn contains(haystack: &str, needle: &str, sensitive: bool) -> bool {
    if sensitive {
        haystack.contains(needle)
    } else {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    }
}
impl GitProject {
    pub(super) async fn search_text_page(
        &self,
        args: &SearchTextArguments,
    ) -> Result<SearchTextPage, ProjectTextError> {
        if args.text.is_empty()
            || args.text.len() > 1024
            || !(1..=100).contains(&args.limit_matches)
        {
            return Err(ProjectTextError::InvalidInput(
                "Invalid literal search bounds".into(),
            ));
        }
        self.check_text_root()?;
        if !args.directory.is_empty() {
            self.checked_text_path(&args.directory)
                .map_err(|error| match error {
                    TextLoadError::Skipped { record, .. }
                        if matches!(
                            record.reason,
                            TextSkipReason::InvalidPath | TextSkipReason::Symlink
                        ) =>
                    {
                        ProjectTextError::InvalidInput(record.detail)
                    }
                    other => other.into_pinned(),
                })?;
        }
        let mut identity_args = args.clone();
        identity_args.continuation = None;
        let query_sha256 = hash(
            &serde_json::to_vec(&identity_args)
                .map_err(|error| ProjectTextError::InvalidInput(error.to_string()))?,
        );
        let mut cursor = args
            .continuation
            .clone()
            .unwrap_or_else(|| SearchTextCursor {
                project: self.identity.clone(),
                query_sha256: query_sha256.clone(),
                directories: vec![DirectoryScanFrame {
                    path: args.directory.clone(),
                    after_name: None,
                }],
                active_file: None,
            });
        if cursor.project != self.identity {
            return Err(ProjectTextError::ObservationExpired(
                "Search continuation belongs to a different project".into(),
            ));
        }
        if cursor.query_sha256 != query_sha256 || cursor.directories.len() > 64 {
            return Err(ProjectTextError::InvalidInput(
                "Search continuation query or directory-depth mismatch".into(),
            ));
        }
        for frame in &cursor.directories {
            if !args.directory.is_empty()
                && frame.path != args.directory
                && !frame.path.starts_with(&format!("{}/", args.directory))
            {
                return Err(ProjectTextError::InvalidInput(
                    "Search continuation outside requested directory".into(),
                ));
            }
        }
        let mut page = SearchTextPage { matches: vec![], skipped: vec![], scanned_entries: 0, scanned_bytes: 0, verified_bytes: 0, continuation: None, complete: false, limit_reason: None, consistency: "Each file has its own verified content version. Directory traversal is live lexical enumeration, not an atomic tree snapshot; entries added behind an already visited name require a new search.".into() };
        let mut loaded = None;
        let mut verification_budget_used = 0u64;
        let mut directory_cache: Option<(String, std::collections::VecDeque<DirectoryEntry>)> =
            None;
        loop {
            page.continuation = Some(cursor.clone());
            // Reserve room for one entry and its cursor before advancing the traversal.
            if json_size(&page) > PAGE_BYTES - 8192 {
                page.limit_reason = Some("utf8_byte_budget".into());
                break;
            }
            if page.matches.len() >= args.limit_matches as usize {
                page.limit_reason = Some("match_budget".into());
                break;
            }
            if page.scanned_bytes >= MATCH_SCAN_BYTES as u64
                || page.scanned_entries >= SCAN_ENTRIES
                || (verification_budget_used >= VERIFY_BYTES && loaded.is_none())
            {
                page.limit_reason = Some("scan_budget".into());
                break;
            }
            if let Some(active) = cursor.active_file.take() {
                if !args.directory.is_empty()
                    && !active
                        .file
                        .path
                        .starts_with(&format!("{}/", args.directory))
                {
                    return Err(ProjectTextError::InvalidInput(
                        "Active search file outside requested directory".into(),
                    ));
                }
                let cached = loaded.is_some();
                let data = if let Some(data) = loaded.take() {
                    data
                } else {
                    self.load_text(&active.file.path, Some(&active.file), None)
                        .await
                        .map_err(TextLoadError::into_pinned)?
                };
                if !cached {
                    page.verified_bytes += data.identity.byte_size;
                    verification_budget_used += data.identity.byte_size;
                }
                let (mut offset, mut line) = self.verify_cursor(&data, &active)?;
                let stop = (offset + MATCH_SCAN_BYTES.saturating_sub(page.scanned_bytes as usize))
                    .min(data.text.len());
                while offset < stop {
                    let next = offset + data.text[offset..].chars().next().unwrap().len_utf8();
                    let bytes = data.text.as_bytes();
                    let matched =
                        match_length(&data.text[offset..], &args.text, args.case_sensitive);
                    if let Some(match_bytes) = matched {
                        let snippet = data.text[offset..].chars().take(160).collect();
                        let found = TextMatch {
                            file: data.identity.clone(),
                            line,
                            byte_start: offset as u64,
                            byte_end: (offset + match_bytes) as u64,
                            snippet,
                            read: ReadTextArguments {
                                path: data.identity.path.clone(),
                                expected_sha256: Some(data.identity.sha256.clone()),
                                start_line: line,
                                limit_lines: 5,
                                continuation: None,
                            },
                        };
                        page.matches.push(found);
                        cursor.active_file = Some(self.cursor(
                            &data,
                            next,
                            line + u64::from(bytes[offset] == b'\n'),
                        ));
                        page.continuation = Some(cursor.clone());
                        if json_size(&page) > PAGE_BYTES - 512 {
                            page.matches.pop();
                            cursor.active_file = Some(self.cursor(&data, offset, line));
                            page.limit_reason = Some("utf8_byte_budget".into());
                            break;
                        }
                    }
                    page.scanned_bytes += (next - offset) as u64;
                    if bytes[offset] == b'\n' {
                        line += 1;
                    }
                    offset = next;
                    if page.matches.len() >= args.limit_matches as usize {
                        page.limit_reason = Some("match_budget".into());
                        break;
                    }
                }
                if page.limit_reason.as_deref() != Some("utf8_byte_budget") {
                    cursor.active_file =
                        (offset < data.text.len()).then(|| self.cursor(&data, offset, line));
                }
                if page.limit_reason.is_some() {
                    break;
                }
                continue;
            }
            let Some(frame) = cursor.directories.last_mut() else {
                break;
            };
            let previous_name = frame.after_name.clone();
            let directory = if directory_cache
                .as_ref()
                .is_some_and(|(path, entries)| path == &frame.path && !entries.is_empty())
            {
                let (_, entries) = directory_cache.as_mut().unwrap();
                Ok(DirectoryPage {
                    path: frame.path.clone(),
                    entries: vec![entries.pop_front().unwrap()],
                    next_name: None,
                    truncated: false,
                    notices: vec![],
                })
            } else {
                match self
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
                        directory_cache = Some((frame.path.clone(), entries));
                        Ok(page)
                    }
                    Err(error) => Err(error),
                }
            };
            let entry = match directory {
                Ok(list) => {
                    if list.truncated {
                        page.skipped.push(skip(
                            &frame.path,
                            TextSkipReason::InvalidEncoding,
                            "Non-UTF-8 directory names cannot be enumerated by the path protocol",
                        ));
                    }
                    let Some(entry) = list.entries.into_iter().next() else {
                        cursor.directories.pop();
                        continue;
                    };
                    frame.after_name = Some(entry.name.clone());
                    entry
                }
                Err(error) => {
                    self.check_text_root()?;
                    page.skipped
                        .push(skip(&frame.path, TextSkipReason::Unreadable, error));
                    cursor.directories.pop();
                    continue;
                }
            };
            page.scanned_entries += 1;
            if !args.show_hidden && entry.name.starts_with('.') {
                continue;
            }
            if entry.kind == "directory" {
                if cursor.directories.len() == 64 {
                    page.skipped.push(skip(&entry.path, TextSkipReason::Unsupported,"Maximum directory depth is 64; search this directory explicitly to continue"));
                } else {
                    cursor.directories.push(DirectoryScanFrame {
                        path: entry.path,
                        after_name: None,
                    });
                }
                continue;
            }
            if args
                .filename_contains
                .as_ref()
                .is_some_and(|needle| !contains(&entry.name, needle, args.case_sensitive))
            {
                continue;
            }
            if entry.byte_size <= MAX_FILE_BYTES
                && verification_budget_used + entry.byte_size > VERIFY_BYTES
            {
                // Leave this name unconsumed so the next page can verify it with a fresh budget.
                // Restore the parent position from before this entry, avoiding a skip under budget exhaustion.
                cursor.directories.last_mut().unwrap().after_name = previous_name;
                page.limit_reason = Some("identity_verification_budget".into());
                break;
            }
            match self.load_text(&entry.path, None, None).await {
                Ok(data) => {
                    // Search immediately in the active-file branch. Validation is accounted there.
                    page.verified_bytes += data.identity.byte_size;
                    verification_budget_used += data.identity.byte_size;
                    cursor.active_file = Some(self.cursor(&data, data.bom, 1));
                    loaded = Some(data);
                }
                Err(TextLoadError::Skipped {
                    record: skipped, ..
                }) => {
                    verification_budget_used += entry.byte_size.min(MAX_FILE_BYTES);
                    page.skipped.push(skipped);
                }
                Err(TextLoadError::Failure(error)) => return Err(error),
            }
        }
        page.complete = cursor.active_file.is_none() && cursor.directories.is_empty();
        page.continuation = (!page.complete).then_some(cursor);
        if page.complete {
            page.limit_reason = None;
        }
        if json_size(&page) > PAGE_BYTES {
            return Err(ProjectTextError::BudgetExceeded(
                "Search continuation exceeds 64 KiB; narrow the directory".into(),
            ));
        }
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read_args(path: &str) -> ReadTextArguments {
        ReadTextArguments {
            path: path.into(),
            expected_sha256: None,
            start_line: 1,
            limit_lines: 200,
            continuation: None,
        }
    }
    fn search_args(text: &str) -> SearchTextArguments {
        SearchTextArguments {
            text: text.into(),
            case_sensitive: false,
            directory: String::new(),
            filename_contains: None,
            show_hidden: false,
            limit_matches: 100,
            continuation: None,
        }
    }
    #[tokio::test]
    async fn text_unicode_bom_crlf_long_line_continues_without_loss() {
        let dir = tempfile::tempdir().unwrap();
        let content = format!("\u{feff}{}\r\n第二行\n", "😀\\\"".repeat(20000));
        std::fs::write(dir.path().join("text.R"), &content).unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = read_args("text.R");
        let mut combined = String::new();
        let mut pages = 0;
        loop {
            let page = project.read_text_page(&args).await.unwrap();
            assert!(json_size(&page) <= PAGE_BYTES);
            assert_eq!(page.file.as_ref().unwrap().encoding, "utf-8-bom");
            for fragment in page.fragments {
                combined.push_str(&fragment.text);
            }
            pages += 1;
            args.continuation = page.continuation;
            if args.continuation.is_none() {
                assert!(page.complete);
                break;
            }
            assert!(pages < 100);
        }
        assert!(pages > 1);
        assert_eq!(combined, content.trim_start_matches('\u{feff}'));
    }
    #[tokio::test]
    async fn text_same_length_replace_and_symlink_refuse_old_page() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("text");
        std::fs::write(&path, "a\nb\n").unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = read_args("text");
        args.limit_lines = 1;
        args.continuation = project.read_text_page(&args).await.unwrap().continuation;
        std::fs::write(&path, "a\nc\n").unwrap();
        assert!(matches!(
            project.read_text_page(&args).await,
            Err(ProjectTextError::ContentChanged(_))
        ));
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink("other", &path).unwrap();
            assert!(matches!(
                project.read_text_page(&args).await,
                Err(ProjectTextError::ContentChanged(_))
            ));
            assert!(matches!(
                project
                    .read_text_page(&read_args("text"))
                    .await
                    .unwrap()
                    .skipped
                    .unwrap()
                    .reason,
                TextSkipReason::Symlink
            ));
        }
    }
    #[tokio::test]
    async fn directory_ten_thousand_names_complete_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        for index in (0..10001).rev() {
            std::fs::write(dir.path().join(format!("item{index:05}")), "").unwrap();
        }
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = ListDirectoryArguments {
            path: String::new(),
            after_name: None,
            limit: 200,
        };
        let mut names = BTreeSet::new();
        loop {
            let page = project.list_directory(&args).await.unwrap();
            assert!(!page.truncated);
            assert!(page.entries.len() <= 200);
            for entry in page.entries {
                assert!(names.insert(entry.name));
            }
            args.after_name = page.next_name;
            if args.after_name.is_none() {
                break;
            }
        }
        assert_eq!(names.len(), 10001);
    }
    #[tokio::test]
    async fn search_budget_zero_matches_continues_and_skips_are_retained() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a-large"),
            format!("{}\nNeedle résumé\n", "x".repeat(MATCH_SCAN_BYTES + 50)),
        )
        .unwrap();
        std::fs::write(dir.path().join("b-binary"), [0, 1, 2]).unwrap();
        std::fs::write(dir.path().join("c-invalid"), [255, 255]).unwrap();
        let huge = std::fs::File::create(dir.path().join("d-huge")).unwrap();
        huge.set_len(MAX_FILE_BYTES + 1).unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = search_args("NEEDLE RÉSUMÉ");
        let first = project.search_text_page(&args).await.unwrap();
        assert!(first.matches.is_empty());
        assert!(!first.complete);
        assert!(first.continuation.is_some());
        args.continuation = first.continuation;
        let mut found = vec![];
        let mut skipped = vec![];
        for _ in 0..10 {
            let page = project.search_text_page(&args).await.unwrap();
            assert!(json_size(&page) <= PAGE_BYTES);
            found.extend(page.matches);
            skipped.extend(page.skipped);
            args.continuation = page.continuation;
            if page.complete {
                break;
            }
        }
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 2);
        assert_eq!(skipped.len(), 3);
        assert!(args.continuation.is_none());
        assert_eq!(
            project
                .read_text_page(&found[0].read)
                .await
                .unwrap()
                .fragments[0]
                .text,
            "Needle résumé\n"
        );
    }
    #[tokio::test]
    async fn search_match_pages_are_version_pinned_and_query_bound() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("matches");
        std::fs::write(&path, "needle\n".repeat(250)).unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = search_args("needle");
        let page = project.search_text_page(&args).await.unwrap();
        assert!(!page.matches.is_empty() && page.matches.len() <= 100);
        let first_count = page.matches.len();
        let mut lines = page
            .matches
            .iter()
            .map(|found| found.line)
            .collect::<BTreeSet<_>>();
        args.continuation = page.continuation;
        let mut changed = args.clone();
        changed.text = "other".into();
        assert!(matches!(
            project.search_text_page(&changed).await,
            Err(ProjectTextError::InvalidInput(_))
        ));
        let second = project.search_text_page(&args).await.unwrap();
        assert!(!second.matches.is_empty() && second.matches.len() <= 100);
        assert_eq!(second.matches[0].line, first_count as u64 + 1);
        let pinned_args = args.clone();
        for found in second.matches {
            assert!(lines.insert(found.line));
        }
        args.continuation = second.continuation;
        while args.continuation.is_some() {
            let page = project.search_text_page(&args).await.unwrap();
            assert!(json_size(&page) <= PAGE_BYTES);
            for found in page.matches {
                assert!(lines.insert(found.line));
            }
            args.continuation = page.continuation;
        }
        assert_eq!(lines, (1..=250).collect());
        args = pinned_args;
        std::fs::write(&path, "Needle\n".repeat(250)).unwrap();
        assert!(matches!(
            project.search_text_page(&args).await,
            Err(ProjectTextError::ContentChanged(_))
        ));
    }
    #[tokio::test]
    async fn private_paths_and_linked_directories_never_enter_search() {
        let dir = tempfile::tempdir().unwrap();
        let private = dir.path().join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::write(private.join("secret"), "needle").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&private, dir.path().join("link")).unwrap();
        let project = GitProject::open(dir.path(), vec![private]).unwrap();
        let page = project
            .search_text_page(&search_args("needle"))
            .await
            .unwrap();
        assert!(page.matches.is_empty());
        assert!(page.complete);
        assert!(
            project
                .read_text_page(&read_args("private/secret"))
                .await
                .unwrap()
                .skipped
                .is_some()
        );
    }
}

#[cfg(test)]
mod continuation_tests {
    use super::*;
    fn search(text: &str) -> SearchTextArguments {
        SearchTextArguments {
            text: text.into(),
            case_sensitive: true,
            directory: String::new(),
            filename_contains: None,
            show_hidden: false,
            limit_matches: 1,
            continuation: None,
        }
    }
    #[tokio::test]
    async fn skipped_records_span_pages_and_missing_file_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..251 {
            std::fs::write(dir.path().join(format!("binary{index:03}")), [0, 255]).unwrap();
        }
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = search("absent");
        let mut skipped = BTreeSet::new();
        let mut pages = 0;
        loop {
            let page = project.search_text_page(&args).await.unwrap();
            assert!(page.matches.is_empty());
            assert!(json_size(&page) <= PAGE_BYTES);
            for record in page.skipped {
                assert!(skipped.insert(record.path));
            }
            pages += 1;
            args.continuation = page.continuation;
            if page.complete {
                break;
            }
            assert!(pages < 10);
        }
        assert!(pages >= 2);
        assert_eq!(skipped.len(), 251);
        let page = project
            .read_text_page(&ReadTextArguments {
                path: "missing".into(),
                expected_sha256: None,
                start_line: 1,
                limit_lines: 200,
                continuation: None,
            })
            .await
            .unwrap();
        assert!(matches!(
            page.skipped.unwrap().reason,
            TextSkipReason::Unreadable
        ));
    }
    #[tokio::test]
    async fn all_match_positions_are_read_once_across_nested_directories() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("a"), "hit hit\nhit").unwrap();
        std::fs::write(dir.path().join("nested/b"), "hit\nhit").unwrap();
        std::fs::write(dir.path().join("z"), "hit").unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = search("hit");
        let mut positions = BTreeSet::new();
        let mut pages = 0;
        loop {
            let page = project.search_text_page(&args).await.unwrap();
            for found in page.matches {
                assert!(positions.insert((found.file.path, found.byte_start)));
            }
            pages += 1;
            args.continuation = page.continuation;
            if page.complete {
                break;
            }
            assert!(pages < 20);
        }
        assert_eq!(positions.len(), 6);
    }
}

#[cfg(test)]
mod typed_error_tests {
    use super::*;
    fn read(path: &str) -> ReadTextArguments {
        ReadTextArguments {
            path: path.into(),
            expected_sha256: None,
            start_line: 1,
            limit_lines: 1,
            continuation: None,
        }
    }
    fn search() -> SearchTextArguments {
        SearchTextArguments {
            text: "hit".into(),
            case_sensitive: true,
            directory: String::new(),
            filename_contains: None,
            show_hidden: false,
            limit_matches: 1,
            continuation: None,
        }
    }
    #[tokio::test]
    async fn pinned_removal_project_scope_and_invalid_positions_have_distinct_errors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("text"), "界\nnext\n").unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let first = project.read_text_page(&read("text")).await.unwrap();
        let mut args = read("text");
        args.continuation = first.continuation;
        let original = args.clone();
        args.continuation.as_mut().unwrap().project = "/different-project".into();
        assert!(matches!(
            project.read_text_page(&args).await,
            Err(ProjectTextError::ObservationExpired(_))
        ));
        args = original.clone();
        args.continuation.as_mut().unwrap().byte_offset = 1;
        args.continuation.as_mut().unwrap().line = 1;
        assert!(matches!(
            project.read_text_page(&args).await,
            Err(ProjectTextError::InvalidInput(_))
        ));
        args = original.clone();
        args.path = "another".into();
        assert!(matches!(
            project.read_text_page(&args).await,
            Err(ProjectTextError::InvalidInput(_))
        ));
        std::fs::remove_file(dir.path().join("text")).unwrap();
        assert!(matches!(
            project.read_text_page(&original).await,
            Err(ProjectTextError::ContentChanged(_))
        ));
        let missing = project.read_text_page(&read("text")).await.unwrap();
        assert!(matches!(
            missing.skipped.unwrap().reason,
            TextSkipReason::Unreadable
        ));
    }
    #[tokio::test]
    async fn pinned_search_and_oversized_cursor_preserve_typed_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("text"), "hit\nhit\n").unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let mut args = search();
        args.continuation = project.search_text_page(&args).await.unwrap().continuation;
        let original = args.clone();
        args.continuation.as_mut().unwrap().project = "/other".into();
        assert!(matches!(
            project.search_text_page(&args).await,
            Err(ProjectTextError::ObservationExpired(_))
        ));
        args = original.clone();
        args.text = "different".into();
        assert!(matches!(
            project.search_text_page(&args).await,
            Err(ProjectTextError::InvalidInput(_))
        ));
        args = original.clone();
        args.continuation.as_mut().unwrap().directories = vec![
            DirectoryScanFrame {
                path: "x".repeat(1024),
                after_name: None
            };
            64
        ];
        assert!(matches!(
            project.search_text_page(&args).await,
            Err(ProjectTextError::BudgetExceeded(_))
        ));
        std::fs::write(dir.path().join("text"), "HIT\nHIT\n").unwrap();
        assert!(matches!(
            project.search_text_page(&original).await,
            Err(ProjectTextError::ContentChanged(_))
        ));
    }
    #[tokio::test]
    async fn expected_hash_does_not_convert_a_replaced_binary_file_into_an_unpinned_skip() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("text"), "plain\n").unwrap();
        let project = GitProject::open(dir.path(), vec![]).unwrap();
        let first = project.read_text_page(&read("text")).await.unwrap();
        let mut args = read("text");
        args.expected_sha256 = Some(first.file.unwrap().sha256);
        std::fs::write(dir.path().join("text"), [0, 1, 2]).unwrap();
        assert!(matches!(
            project.read_text_page(&args).await,
            Err(ProjectTextError::ContentChanged(_))
        ));
        assert!(matches!(
            project
                .read_text_page(&read("text"))
                .await
                .unwrap()
                .skipped
                .unwrap()
                .reason,
            TextSkipReason::Binary
        ));
        args.expected_sha256 = Some(hash(&[0, 1, 2]));
        assert!(matches!(
            project
                .read_text_page(&args)
                .await
                .unwrap()
                .skipped
                .unwrap()
                .reason,
            TextSkipReason::Binary
        ));
    }
    #[test]
    fn io_error_kind_not_message_text_classifies_pinned_unavailability() {
        assert!(matches!(
            skipped_io(
                "text",
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "content_changed")
            )
            .into_pinned(),
            ProjectTextError::Unavailable(_)
        ));
        assert!(matches!(
            skipped_io(
                "text",
                std::io::Error::new(std::io::ErrorKind::NotFound, "unavailable")
            )
            .into_pinned(),
            ProjectTextError::ContentChanged(_)
        ));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn replaced_project_root_expires_both_read_and_search_observations() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("text"), "hit\nhit\n").unwrap();
        let project = GitProject::open(&root, vec![]).unwrap();
        let mut args = read("text");
        args.continuation = project.read_text_page(&args).await.unwrap().continuation;
        let moved = dir.path().join("moved");
        std::fs::rename(&root, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &root).unwrap();
        assert!(matches!(
            project.read_text_page(&args).await,
            Err(ProjectTextError::ObservationExpired(_))
        ));
        assert!(matches!(
            project.search_text_page(&search()).await,
            Err(ProjectTextError::ObservationExpired(_))
        ));
    }
}
