use super::*;
use rho_project::*;

const PAGE_BYTES: usize = 64 * 1024;
const MATCH_SCAN_BYTES: usize = 1024 * 1024;
const VERIFY_BYTES: u64 = 64 * 1024 * 1024;
const SCAN_ENTRIES: u32 = 200;

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
    async fn load_text(&self, path: &str) -> Result<TextData, TextSkip> {
        let resolved = self
            .checked_path(path)
            .map_err(|e| skip(path, TextSkipReason::InvalidPath, e))?;
        let before = std::fs::symlink_metadata(&resolved)
            .map_err(|e| skip(path, TextSkipReason::Unreadable, e.to_string()))?;
        if before.file_type().is_symlink() {
            return Err(skip(
                path,
                TextSkipReason::Symlink,
                "Text reads do not follow symbolic links",
            ));
        }
        if !before.is_file() {
            return Err(skip(
                path,
                TextSkipReason::Unsupported,
                "Text requires a regular file",
            ));
        }
        if before.len() > MAX_FILE_BYTES {
            return Err(skip(
                path,
                TextSkipReason::Oversize,
                "Text identity verification is limited to 64 MiB per file",
            ));
        }
        let mut file = tokio::fs::File::open(&resolved)
            .await
            .map_err(|e| skip(path, TextSkipReason::Unreadable, e.to_string()))?;
        let opened = file
            .metadata()
            .await
            .map_err(|e| skip(path, TextSkipReason::Unreadable, e.to_string()))?;
        if native_identity(&opened) != native_identity(&before) {
            return Err(skip(
                path,
                TextSkipReason::Unreadable,
                "content_changed: file replaced during open",
            ));
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| skip(path, TextSkipReason::Unreadable, e.to_string()))?;
        self.checked_path(path)
            .map_err(|e| skip(path, TextSkipReason::InvalidPath, e))?;
        let after = std::fs::symlink_metadata(&resolved)
            .map_err(|e| skip(path, TextSkipReason::Unreadable, e.to_string()))?;
        let after_open = file
            .metadata()
            .await
            .map_err(|e| skip(path, TextSkipReason::Unreadable, e.to_string()))?;
        if native_identity(&before) != native_identity(&after)
            || native_identity(&before) != native_identity(&after_open)
            || after.file_type().is_symlink()
            || bytes.len() as u64 != before.len()
        {
            return Err(skip(
                path,
                TextSkipReason::Unreadable,
                "content_changed: file changed during identity verification",
            ));
        }
        if bytes.contains(&0) {
            return Err(skip(
                path,
                TextSkipReason::Binary,
                "NUL bytes indicate binary or unsupported non-UTF-8 text",
            ));
        }
        let sha256 = hash(&bytes);
        let bom = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            3
        } else {
            0
        };
        let text = String::from_utf8(bytes).map_err(|_| {
            skip(
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
    fn verify_cursor(&self, data: &TextData, cursor: &TextCursor) -> Result<(usize, u64), String> {
        if cursor.project != self.identity || cursor.file != data.identity {
            return Err("content_changed: continuation does not identify the current project/file version; restart the read".into());
        }
        let byte = usize::try_from(cursor.byte_offset).map_err(display)?;
        if byte < data.bom
            || byte > data.text.len()
            || !data.text.is_char_boundary(byte)
            || cursor.line
                != 1 + data.text.as_bytes()[data.bom..byte]
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count() as u64
        {
            return Err("invalid text continuation position".into());
        }
        Ok((byte, cursor.line))
    }
    pub(super) async fn read_text_page(
        &self,
        args: &ReadTextArguments,
    ) -> Result<TextPage, String> {
        if args.start_line == 0 || !(1..=200).contains(&args.limit_lines) {
            return Err("invalid text line bounds".into());
        }
        let data = match self.load_text(&args.path).await {
            Ok(data) => data,
            Err(skipped) if args.continuation.is_some() => {
                return Err(format!(
                    "content_changed: pinned file is no longer readable: {}",
                    skipped.detail
                ));
            }
            Err(skipped) => {
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
            return Err("content_changed: expected file digest does not match".into());
        }
        let (mut offset, mut line) = if let Some(cursor) = &args.continuation {
            if cursor.file.path != args.path {
                return Err("text continuation path mismatch".into());
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
    ) -> Result<SearchTextPage, String> {
        if args.text.is_empty()
            || args.text.len() > 1024
            || !(1..=100).contains(&args.limit_matches)
        {
            return Err("invalid literal search bounds".into());
        }
        if !args.directory.is_empty() {
            self.checked_path(&args.directory)?;
        }
        let mut identity_args = args.clone();
        identity_args.continuation = None;
        let query_sha256 = hash(&serde_json::to_vec(&identity_args).map_err(display)?);
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
        if cursor.project != self.identity
            || cursor.query_sha256 != query_sha256
            || cursor.directories.len() > 64
        {
            return Err("search continuation project/query mismatch".into());
        }
        for frame in &cursor.directories {
            if !args.directory.is_empty()
                && frame.path != args.directory
                && !frame.path.starts_with(&format!("{}/", args.directory))
            {
                return Err("search continuation outside requested directory".into());
            }
        }
        let mut page = SearchTextPage { matches: vec![], skipped: vec![], scanned_entries: 0, scanned_bytes: 0, verified_bytes: 0, continuation: None, complete: false, limit_reason: None, consistency: "Each file has its own verified content version. Directory traversal is live lexical enumeration, not an atomic tree snapshot; entries added behind an already visited name require a new search.".into() };
        let mut loaded = None;
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
                || page.verified_bytes >= VERIFY_BYTES
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
                    return Err("active search file outside requested directory".into());
                }
                let data = if let Some(data) = loaded.take() {
                    data
                } else {
                    self.load_text(&active.file.path).await.map_err(|e| {
                        format!(
                            "content_changed: pinned search file cannot be read: {}",
                            e.detail
                        )
                    })?
                };
                let (mut offset, mut line) = self.verify_cursor(&data, &active)?;
                page.verified_bytes += data.identity.byte_size;
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
                && page.verified_bytes + entry.byte_size > VERIFY_BYTES
            {
                // Leave this name unconsumed so the next page can verify it with a fresh budget.
                // Restore the parent position from before this entry, avoiding a skip under budget exhaustion.
                cursor.directories.last_mut().unwrap().after_name = previous_name;
                page.limit_reason = Some("identity_verification_budget".into());
                break;
            }
            match self.load_text(&entry.path).await {
                Ok(data) => {
                    // Search immediately in the active-file branch. Validation is accounted there.
                    cursor.active_file = Some(self.cursor(&data, data.bom, 1));
                    loaded = Some(data);
                }
                Err(skipped) => {
                    page.verified_bytes += entry.byte_size.min(MAX_FILE_BYTES);
                    page.skipped.push(skipped);
                }
            }
        }
        page.complete = cursor.active_file.is_none() && cursor.directories.is_empty();
        page.continuation = (!page.complete).then_some(cursor);
        if page.complete {
            page.limit_reason = None;
        }
        if json_size(&page) > PAGE_BYTES {
            return Err(
                "budget_exhausted: search continuation exceeds 64 KiB; narrow the directory".into(),
            );
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
        assert!(
            project
                .read_text_page(&args)
                .await
                .unwrap_err()
                .contains("content_changed")
        );
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink("other", &path).unwrap();
            assert!(
                project
                    .read_text_page(&args)
                    .await
                    .unwrap_err()
                    .contains("content_changed")
            );
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
        assert_eq!(page.matches.len(), 100);
        args.continuation = page.continuation;
        let mut changed = args.clone();
        changed.text = "other".into();
        assert!(
            project
                .search_text_page(&changed)
                .await
                .unwrap_err()
                .contains("mismatch")
        );
        let second = project.search_text_page(&args).await.unwrap();
        assert_eq!(second.matches.len(), 100);
        assert_eq!(second.matches[0].line, 101);
        std::fs::write(&path, "Needle\n".repeat(250)).unwrap();
        assert!(
            project
                .search_text_page(&args)
                .await
                .unwrap_err()
                .contains("content_changed")
        );
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
