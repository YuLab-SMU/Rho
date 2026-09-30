use rho_files_api::*;

/// Bounded path traversal; continuation is tied to this root and exact query.
pub async fn search_files(
    runtime: &dyn ProjectRuntime,
    args: &SearchFilesArguments,
) -> Result<FileSearchResult, String> {
    validate_search_files(args)?;
    list_matching_files(runtime, args, 200).await
}

/// Bounded discovery also accepts an empty filter for a user-opened context picker.
pub async fn list_matching_files(
    runtime: &dyn ProjectRuntime,
    args: &SearchFilesArguments,
    limit: usize,
) -> Result<FileSearchResult, String> {
    if args.text.len() > 1024 || !(1..=200).contains(&limit) {
        return Err("Invalid file discovery bounds".into());
    }
    let mut cursor = args
        .continuation
        .clone()
        .unwrap_or_else(|| SearchFilesCursor {
            project: runtime.root().into(),
            text: args.text.clone(),
            show_hidden: args.show_hidden,
            directories: vec![DirectoryScanFrame {
                path: String::new(),
                after_name: None,
            }],
        });
    if cursor.project != runtime.root()
        || cursor.text != args.text
        || cursor.show_hidden != args.show_hidden
        || cursor.directories.len() > 64
    {
        return Err(String::from(
            "path search continuation project/query mismatch",
        ));
    }
    let mut result = FileSearchResult {
        entries: vec![],
        scanned_entries: 0,
        scanned_directories: 0,
        truncated: false,
        notices: vec![],
        continuation: None,
    };
    let needle = args.text.to_lowercase();
    let mut cache: Option<(String, std::collections::VecDeque<DirectoryEntry>)> = None;
    while !cursor.directories.is_empty() {
        result.continuation = Some(cursor.clone());
        if result.scanned_entries >= 10000
            || result.scanned_directories >= 200
            || result.entries.len() >= limit
            || serde_json::to_vec(&result)
                .map_err(|error| error.to_string())?
                .len()
                > 56 * 1024
        {
            result.truncated = true;
            result.notices.push(
                "Page budget reached; continue with the unchanged query and returned continuation."
                    .into(),
            );
            break;
        }
        let frame = cursor.directories.last_mut().unwrap();
        if !frame.path.is_empty() {
            validate_path(&frame.path).map_err(|error| error.to_string())?;
        }
        if frame
            .after_name
            .as_ref()
            .is_some_and(|name| name.len() > 1024 || name.contains('/'))
        {
            return Err(String::from("invalid path continuation name"));
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
            match runtime
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
    if serde_json::to_vec(&result)
        .map_err(|error| error.to_string())?
        .len()
        > 64 * 1024
    {
        return Err(String::from(
            "path search continuation exceeds 64 KiB; browse a narrower directory",
        ));
    }
    Ok(result)
}
